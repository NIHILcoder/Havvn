/**
 * Unit tests for the PURE parts of the elevated helper — the pieces that must be
 * provable without spawning PowerShell, a driver, or an admin token:
 *  - pruneHelperLogs: the Phase-2A `<handshake>*.log` rotation.
 *  - parseDiagSections: the marker-delimited diag output parser.
 *
 * The elevated code paths (applyNetConfig / applyAppFirewallRule / gatherHelperFacts)
 * shell out and are covered live; importing this module must NOT touch koffi, the
 * driver, or electron — that import-time purity is itself asserted below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneHelperLogs, parseDiagSections, HELPER_LOG_KEEP, MAX_LAN_APP_RULES } from './helper-main';

let dir: string;

/** Create `<dir>/<name>` with an explicit mtime so ordering is deterministic. */
function touch(name: string, ageMinutes: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, name, 'utf8');
  const t = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-lan-log-'));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('pruneHelperLogs', () => {
  it('keeps the newest logs INCLUDING the live one and removes the rest', () => {
    // 8 logs, oldest first by age; index 0 is the freshest.
    for (let i = 0; i < 8; i++) touch(`handshake-s${i}.json.log`, i * 10);
    const live = path.join(dir, 'handshake-s0.json.log');

    const removed = pruneHelperLogs(live, HELPER_LOG_KEEP);

    const left = fs.readdirSync(dir).sort();
    expect(left.length).toBe(HELPER_LOG_KEEP);
    expect(left).toContain('handshake-s0.json.log'); // the live log always survives
    expect(left).toEqual([
      'handshake-s0.json.log',
      'handshake-s1.json.log',
      'handshake-s2.json.log',
      'handshake-s3.json.log',
      'handshake-s4.json.log',
    ]);
    expect(removed.sort()).toEqual([
      'handshake-s5.json.log',
      'handshake-s6.json.log',
      'handshake-s7.json.log',
    ]);
  });

  it('never deletes the live log even when it is the OLDEST file', () => {
    for (let i = 0; i < 6; i++) touch(`handshake-s${i}.json.log`, i * 10);
    const live = path.join(dir, 'handshake-s5.json.log'); // oldest mtime
    pruneHelperLogs(live, 2);
    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual(['handshake-s0.json.log', 'handshake-s5.json.log']);
  });

  it('is a no-op below the keep threshold', () => {
    touch('handshake-a.json.log', 1);
    touch('handshake-b.json.log', 2);
    expect(pruneHelperLogs(path.join(dir, 'handshake-a.json.log'), 5)).toEqual([]);
    expect(fs.readdirSync(dir).length).toBe(2);
  });

  it('touches ONLY handshake-*.log — never the .json handshakes or anything else', () => {
    for (let i = 0; i < 8; i++) touch(`handshake-s${i}.json.log`, i * 10);
    touch('handshake-s0.json', 99); // the live handshake file
    touch('handshake-s9.json', 99); // a stale handshake file (main's job, not ours)
    touch('notes.txt', 99);
    touch('room.log', 99); // wrong prefix

    pruneHelperLogs(path.join(dir, 'handshake-s0.json.log'), HELPER_LOG_KEEP);

    const left = fs.readdirSync(dir);
    expect(left).toContain('handshake-s0.json');
    expect(left).toContain('handshake-s9.json');
    expect(left).toContain('notes.txt');
    expect(left).toContain('room.log');
    expect(left.filter((n) => n.endsWith('.json.log')).length).toBe(HELPER_LOG_KEEP);
  });

  it('swallows a missing directory (rotation must never block a start)', () => {
    expect(() => pruneHelperLogs(path.join(dir, 'nope', 'handshake-x.json.log'))).not.toThrow();
    expect(pruneHelperLogs(path.join(dir, 'nope', 'handshake-x.json.log'))).toEqual([]);
  });

  it('keep=1 leaves only the live log', () => {
    for (let i = 0; i < 4; i++) touch(`handshake-s${i}.json.log`, i * 10);
    pruneHelperLogs(path.join(dir, 'handshake-s2.json.log'), 1);
    expect(fs.readdirSync(dir)).toEqual(['handshake-s2.json.log']);
  });
});

describe('parseDiagSections', () => {
  it('splits marker-delimited output into sections', () => {
    const out = [
      '#HAVVN-ADAPTER',
      'Up',
      '#HAVVN-IP',
      '100.88.4.7',
      '169.254.1.2',
      '#HAVVN-MTU',
      '1280',
      '#HAVVN-FW',
      'Havvn LAN-x In',
      'Havvn LAN-x Out',
      '#HAVVN-END',
    ].join('\r\n');
    expect(parseDiagSections(out)).toEqual({
      adapter: ['Up'],
      ip: ['100.88.4.7', '169.254.1.2'],
      mtu: ['1280'],
      fw: ['Havvn LAN-x In', 'Havvn LAN-x Out'],
      end: [],
    });
  });

  it('yields empty sections when a cmdlet produced nothing (adapter absent)', () => {
    const s = parseDiagSections('#HAVVN-ADAPTER\n#HAVVN-IP\n#HAVVN-FW\n#HAVVN-END\n');
    expect(s.adapter).toEqual([]);
    expect(s.ip).toEqual([]);
    expect((s.adapter ?? [])[0] ?? '').toBe('');
  });

  it('drops blank lines and text preceding the first marker (stray stderr)', () => {
    const s = parseDiagSections('some stderr noise\n\n#HAVVN-ADAPTER\n\n  Up  \n');
    expect(s.adapter).toEqual(['Up']);
    expect(Object.keys(s)).toEqual(['adapter']);
  });

  it('tolerates empty / non-string input', () => {
    expect(parseDiagSections('')).toEqual({});
    expect(parseDiagSections(undefined as unknown as string)).toEqual({});
  });
});

describe('helper bounds', () => {
  it('caps per-session app rules (a looping renderer cannot flood the firewall store)', () => {
    expect(MAX_LAN_APP_RULES).toBeGreaterThan(0);
    expect(MAX_LAN_APP_RULES).toBeLessThanOrEqual(32);
  });

  it('keeps a bounded number of helper logs', () => {
    expect(HELPER_LOG_KEEP).toBe(5);
  });
});
