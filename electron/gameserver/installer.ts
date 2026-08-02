/**
 * Executes an InstallStep[] produced by a game module. This is the ONLY code
 * that turns a module's plan into changes on disk, which is what makes the
 * containment and hash-pinning invariants enforceable rather than aspirational:
 *
 *   • The WHOLE plan is validated before ANY step runs. A plan with a bad step at
 *     index 7 executes zero steps, instead of leaving an instance half-built in a
 *     state no code knows how to reason about.
 *   • Every path goes through resolveUnder(instanceRoot, …), so a step cannot
 *     write outside its instance even if a module tried.
 *   • Every download goes through downloadVerified, so a mismatched digest
 *     aborts the install rather than producing a working-looking server built
 *     from bytes nobody vouched for.
 *   • 'runtime-exec' runs OUR managed runtime with module-authored argv, and its
 *     declared outputs are checked afterwards — a Forge installer that fails
 *     silently (they do) surfaces as an error instead of an unbootable instance.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../utils';
import { downloadVerified } from './fetcher';
import { resolveUnder, ensureDir } from './paths';
import { resolveRuntime, ensureRuntime } from './runtime-store';
import { validateInstallPlan } from '../../shared/gameserver-core';
import type { InstallStep } from '../../shared/gameserver-types';

const log = logger.child('GameInstaller');

export interface InstallProgress {
  /** 1-based index of the running step. */
  step: number;
  steps: number;
  /** Human label for the current step. */
  label: string;
  /** Overall 0..100. */
  pct: number;
}

export class InstallCancelled extends Error {
  constructor() {
    super('installation cancelled');
    this.name = 'InstallCancelled';
  }
}

function labelFor(step: InstallStep): string {
  switch (step.t) {
    case 'fetch': return step.label ?? `downloading ${path.basename(step.into)}`;
    case 'unzip': return `extracting ${path.basename(step.from)}`;
    case 'write': return `writing ${path.basename(step.path)}`;
    case 'remove': return `cleaning up ${path.basename(step.path)}`;
    case 'runtime-exec': return step.label ?? 'running installer';
    default: return 'working';
  }
}

/** Extract with PowerShell (Windows) / tar, matching runtime-store — no zip
 *  dependency ships in the production bundle. */
async function extract(archive: string, into: string, strip: number): Promise<void> {
  ensureDir(into);
  const staging = strip > 0 ? `${into}.stage` : into;
  if (strip > 0) fs.rmSync(staging, { recursive: true, force: true });

  await new Promise<void>((resolve, reject) => {
    const psq = (s: string): string => s.replace(/'/g, "''");
    const child = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${psq(archive)}' -DestinationPath '${psq(staging)}' -Force`],
      { windowsHide: true })
      : spawn('tar', ['-xzf', archive, '-C', staging]);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`extraction failed with code ${code}`))));
  });

  if (strip > 0) {
    let cursor = staging;
    for (let i = 0; i < strip; i++) {
      const entries = fs.readdirSync(cursor, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length !== 1) throw new Error(`cannot strip ${strip} levels: ${dirs.length} directories at depth ${i}`);
      cursor = path.join(cursor, dirs[0].name);
    }
    ensureDir(into);
    for (const entry of fs.readdirSync(cursor)) {
      fs.renameSync(path.join(cursor, entry), path.join(into, entry));
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Run a managed runtime with module-authored argv, bounded by a timeout. */
async function runtimeExec(
  step: Extract<InstallStep, { t: 'runtime-exec' }>,
  instanceRoot: string,
  onLine: (text: string) => void,
): Promise<void> {
  const exe = resolveRuntime(step.runtime) ?? await ensureRuntime(step.runtime);
  const cwd = resolveUnder(instanceRoot, step.cwd);
  ensureDir(cwd);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, step.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`installer timed out after ${Math.round(step.timeoutMs / 1000)}s`));
    }, step.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const relay = (chunk: string): void => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`installer exited with code ${code}`));
    });
  });

  // Installers of this kind are notorious for exiting 0 having produced nothing.
  for (const rel of step.produces) {
    const abs = resolveUnder(instanceRoot, rel);
    if (!fs.existsSync(abs)) throw new Error(`installer finished but did not produce ${rel}`);
  }
}

/**
 * Run a full install plan against an instance root.
 *
 * `onLine` receives installer output so it lands in the same console the user
 * will watch during the run — an install that stalls on a slow mirror should be
 * visible, not a frozen progress bar.
 */
export async function runInstallPlan(
  steps: InstallStep[],
  opts: {
    instanceRoot: string;
    signal?: AbortSignal;
    onProgress?: (p: InstallProgress) => void;
    onLine?: (text: string) => void;
  },
): Promise<void> {
  const { instanceRoot, signal, onProgress, onLine } = opts;

  const valid = validateInstallPlan(steps);
  if (!valid.ok) throw new Error(`refusing to run install plan: ${valid.reason}`);

  ensureDir(instanceRoot);
  const total = steps.length;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new InstallCancelled();
    const step = steps[i];
    const label = labelFor(step);
    const base = Math.round((i / total) * 100);
    const span = Math.round(100 / total);
    onProgress?.({ step: i + 1, steps: total, label, pct: base });
    onLine?.(`[${i + 1}/${total}] ${label}`);

    switch (step.t) {
      case 'fetch': {
        const dest = resolveUnder(instanceRoot, step.into);
        await downloadVerified(step.url, step.hash, dest, {
          ...(signal ? { signal } : {}),
          onProgress: (p) => {
            if (!p.total) return;
            onProgress?.({ step: i + 1, steps: total, label, pct: base + Math.round((p.received / p.total) * span) });
          },
        });
        break;
      }
      case 'unzip': {
        const from = resolveUnder(instanceRoot, step.from);
        const into = resolveUnder(instanceRoot, step.into);
        await extract(from, into, step.strip ?? 0);
        break;
      }
      case 'write': {
        const dest = resolveUnder(instanceRoot, step.path);
        if (step.ifAbsent && fs.existsSync(dest)) {
          onLine?.(`keeping the existing ${step.path}`);
          break;
        }
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, step.text, 'utf8');
        break;
      }
      case 'remove': {
        const dest = resolveUnder(instanceRoot, step.path);
        fs.rmSync(dest, { recursive: true, force: true });
        break;
      }
      case 'runtime-exec': {
        await runtimeExec(step, instanceRoot, (text) => onLine?.(text));
        break;
      }
      default: {
        const never: never = step;
        throw new Error(`unhandled install step ${JSON.stringify(never)}`);
      }
    }
  }

  onProgress?.({ step: total, steps: total, label: 'done', pct: 100 });
  log.info('install plan complete', { steps: total, instanceRoot });
}
