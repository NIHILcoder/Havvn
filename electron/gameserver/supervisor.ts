/**
 * Process supervision for one game-server instance: spawn, pipe, restart, stop.
 * The DECISIONS live in the pure shared/gameserver-core ServerFsm; this file
 * owns only the effects, mirroring how electron/sharing/room-lan.ts is the RTC
 * wiring around a pure lan-session-core.
 *
 * Three things here are easy to get wrong and each cost real debugging time
 * elsewhere in this app, so they are handled explicitly:
 *
 *  1. KILLING A JVM DOES NOT KILL ITS CHILDREN. On Windows child.kill() signals
 *     only the direct child; a server launched through a wrapper leaves the real
 *     JVM running, holding the world files AND the port, so the next start fails
 *     with a confusing "address in use". We kill the TREE with taskkill /T /F.
 *  2. A GRACEFUL STOP IS NOT INSTANT. Minecraft saves the world on shutdown and
 *     legitimately takes tens of seconds on a large map. Killing at 5 s corrupts
 *     saves. The module declares its own graceMs and we honour it, then fall back
 *     to the tree kill.
 *  3. stdin MUST BE LINE-DISCIPLINED. Commands are flattened by clampCommand
 *     before they reach here, so one command can never become two.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { logger } from '../utils';
import { ConsoleBuffer } from './console-buffer';
import { resolveUnder } from './paths';
import {
  ServerFsm, clampCommand, splitLines, validateLaunchPlan,
} from '../../shared/gameserver-core';
import { KILL_GRACE_MS, RESTART_DELAY_MS } from '../../shared/gameserver-types';
import type {
  GameEvent, GameModule, InstanceView, ServerFailReason, ServerStatus,
} from '../../shared/gameserver-types';

const log = logger.child('GameSupervisor');

export interface SupervisorDeps {
  /** Absolute path to the executable for a runtime ref, or null if not installed. */
  resolveRuntime(ref: { id: string; major: number }): string | null;
  /** Absolute instance root (the process cwd base). */
  instanceRoot: string;
  logsDir: string;
  /** Pushed whenever anything the UI shows changed. */
  onChange(): void;
  /** Structured events the manager reacts to (ready → start announcing, etc.). */
  onEvent(e: GameEvent): void;
}

export interface SupervisorSnapshot {
  status: ServerStatus;
  since: number;
  ready: boolean;
  players: string[];
  failReason?: ServerFailReason;
  failDetail?: string;
  restarts: number;
  pid?: number;
}

export class Supervisor extends EventEmitter {
  readonly console: ConsoleBuffer;
  private readonly fsm: ServerFsm;
  private child: ChildProcess | null = null;
  private outCarry = '';
  private errCarry = '';
  private stopTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  /** True between a stop request and the exit, so exited() knows it was us. */
  private expectingExit = false;
  /** User preference: restart automatically after an unexpected exit. */
  autoRestart = true;

  constructor(
    private readonly module: GameModule,
    private view: InstanceView,
    private readonly deps: SupervisorDeps,
  ) {
    super();
    this.console = new ConsoleBuffer(deps.logsDir);
    this.fsm = new ServerFsm(Date.now());
  }

  get status(): ServerStatus { return this.fsm.status; }
  get pid(): number | undefined { return this.child?.pid; }

  snapshot(): SupervisorSnapshot {
    const s = this.fsm.snapshot();
    return { ...s, ...(this.child?.pid ? { pid: this.child.pid } : {}) };
  }

  /** Refresh the instance facts a plan is built from (config edits, a new vIP). */
  updateView(view: InstanceView): void {
    this.view = view;
  }

  /** Replace the tracked population from an out-of-band probe. */
  setPlayers(names: string[]): void {
    this.fsm.setPlayers(names);
    this.deps.onChange();
  }

  clearFailure(): void {
    this.fsm.clearFailure(Date.now());
    this.deps.onChange();
  }

  // ── start ──────────────────────────────────────────────────────────────────

  start(): { ok: true } | { ok: false; reason: string } {
    if (!this.fsm.beginStart(Date.now())) {
      // The FSM only refuses a start when the process is already up or in
      // transition, which reads to a user as "it is already running".
      return { ok: false, reason: 'stop-first' };
    }

    const plan = this.module.planLaunch(this.view);
    const valid = validateLaunchPlan(plan);
    if (!valid.ok) {
      // A first-party module produced an invalid plan: a bug, not user error.
      this.fail('launch-failed', `invalid launch plan: ${valid.reason}`);
      return { ok: false, reason: valid.reason };
    }

    const exe = this.deps.resolveRuntime(plan.runtime);
    if (!exe) {
      this.fail('runtime-missing', `${plan.runtime.id} ${plan.runtime.major} is not installed`);
      return { ok: false, reason: 'runtime-missing' };
    }

    let cwd: string;
    try {
      cwd = resolveUnder(this.deps.instanceRoot, plan.cwd);
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.fail('launch-failed', String(err));
      return { ok: false, reason: String(err) };
    }

    this.console.openLog();
    this.console.system(`starting: ${path.basename(exe)} ${plan.args.join(' ')}`);

    // A MINIMAL environment, never process.env wholesale. A game server has no
    // business inheriting our tokens, proxy settings or NODE_OPTIONS — the last
    // of which would actually be injected into any node-based server we spawn.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      windir: process.env.windir ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      ...plan.env,
    };

    let child: ChildProcess;
    try {
      child = spawn(exe, plan.args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.fail('launch-failed', String(err));
      return { ok: false, reason: String(err) };
    }

    this.child = child;
    this.expectingExit = false;
    this.outCarry = '';
    this.errCarry = '';
    this.wire(child);
    this.deps.onChange();
    return { ok: true };
  }

  private wire(child: ChildProcess): void {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => this.ingest('out', chunk));
    child.stderr?.on('data', (chunk: string) => this.ingest('err', chunk));

    // An EPIPE on stdin (the process closed it) must not crash the app.
    child.stdin?.on('error', (err) => log.warn('stdin error', { err: String(err) }));

    child.on('error', (err) => {
      this.console.system(`process error: ${err.message}`);
      this.fail('launch-failed', err.message);
    });

    child.on('exit', (code, signal) => this.onExit(code, signal));
  }

  private ingest(stream: 'out' | 'err', chunk: string): void {
    const carry = stream === 'out' ? this.outCarry : this.errCarry;
    const { lines, carry: rest } = splitLines(carry, chunk);
    if (stream === 'out') this.outCarry = rest; else this.errCarry = rest;

    for (const raw of lines) {
      const line = this.console.push(stream, raw);
      if (!line.text) continue;
      let events: GameEvent[];
      try {
        events = this.module.parseLine(line.text);
      } catch (err) {
        // A throwing parser must degrade to "no events", never take down the
        // server it is only observing.
        log.warn('parseLine threw', { module: this.module.id, err: String(err) });
        continue;
      }
      for (const e of events) {
        this.fsm.applyEvent(e, Date.now());
        this.deps.onEvent(e);
      }
      if (events.length) this.deps.onChange();
    }
  }

  // ── stop ───────────────────────────────────────────────────────────────────

  /**
   * Ask the server to shut down. Graceful first (the module's own command), then
   * the tree kill after graceMs + KILL_GRACE_MS.
   */
  stop(): { ok: true } | { ok: false; reason: string } {
    this.cancelRestart();
    if (!this.child) {
      return { ok: false, reason: 'not-running' };
    }
    if (!this.fsm.beginStop(Date.now())) {
      return { ok: false, reason: 'not-running' };
    }

    this.expectingExit = true;
    const plan = this.module.stopPlan();

    if (plan.command && this.child.stdin?.writable) {
      this.console.system(`stopping: sending "${plan.command}"`);
      this.child.stdin.write(`${plan.command}\n`);
    } else {
      this.console.system('stopping: no console command available, signalling');
      this.signal();
    }

    this.stopTimer = setTimeout(() => {
      this.console.system(`did not exit within ${Math.round((plan.graceMs + KILL_GRACE_MS) / 1000)}s — terminating`);
      this.killTree();
      this.fsm.killed(Date.now());
      this.deps.onChange();
    }, plan.graceMs + KILL_GRACE_MS);

    this.deps.onChange();
    return { ok: true };
  }

  /** Immediate termination, for app shutdown. */
  kill(): void {
    this.cancelRestart();
    this.expectingExit = true;
    this.killTree();
  }

  private signal(): void {
    try {
      this.child?.kill();
    } catch (err) {
      log.warn('signal failed', { err: String(err) });
    }
  }

  /**
   * Kill the process AND everything it spawned.
   *
   * child.kill() reaches only the direct child. A Minecraft server started via a
   * launcher, or any server that forks a worker, would survive it — keeping the
   * world files locked and the port bound, so the next start fails with an
   * "address already in use" that has no visible cause. taskkill /T walks the
   * tree; the /F is what makes it work on a JVM ignoring the console control
   * event we cannot send it anyway.
   */
  private killTree(): void {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      } catch (err) {
        log.warn('taskkill failed, falling back to signal', { pid, err: String(err) });
        this.signal();
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        this.signal();
      }
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.child = null;

    // Flush whatever was buffered without a trailing newline — a crash message
    // is exactly the kind of line a process emits and then dies before newline.
    if (this.outCarry) { this.console.push('out', this.outCarry); this.outCarry = ''; }
    if (this.errCarry) { this.console.push('err', this.errCarry); this.errCarry = ''; }

    const expected = this.expectingExit;
    this.expectingExit = false;

    const disposition = this.fsm.exited(
      { expected, code, signal, autoRestart: this.autoRestart },
      Date.now(),
    );

    this.console.system(
      expected
        ? 'stopped'
        : `exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? '?'}`})`,
    );

    if (disposition === 'restart') {
      this.console.system(`restarting in ${RESTART_DELAY_MS / 1000}s`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        // exited() parked the FSM in 'starting' so a user pressing Start during
        // the delay cannot produce a second process; prepareRestart is the one
        // way back out, and it keeps the crash budget intact.
        this.fsm.prepareRestart(Date.now());
        const r = this.start();
        if (!r.ok) this.console.system(`restart failed: ${r.reason}`);
      }, RESTART_DELAY_MS);
    } else {
      this.console.closeLog();
    }

    this.deps.onChange();
    this.emit('exit', { code, signal, expected, disposition });
  }

  private cancelRestart(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  private fail(reason: ServerFailReason, detail: string): void {
    this.fsm.startFailed(reason, detail, Date.now());
    this.console.system(`failed: ${detail}`);
    this.console.closeLog();
    this.deps.onChange();
  }

  // ── console input ──────────────────────────────────────────────────────────

  /**
   * Write one command to the server's stdin. The input is flattened first, so a
   * caller cannot smuggle a second command past whatever authorisation check
   * happened upstream.
   */
  sendCommand(input: string): { ok: true; command: string } | { ok: false; reason: string } {
    const command = clampCommand(input);
    if (!command) return { ok: false, reason: 'empty-command' };
    if (!this.child?.stdin?.writable) return { ok: false, reason: 'not-running' };
    if (!this.module.caps.console) return { ok: false, reason: 'no-console' };

    this.console.push('sys', `> ${command}`);
    try {
      this.child.stdin.write(`${command}\n`);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
    return { ok: true, command };
  }

  dispose(): void {
    this.cancelRestart();
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.kill();
    this.console.closeLog();
    this.removeAllListeners();
  }
}
