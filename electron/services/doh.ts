/**
 * DoH template management (main process).
 *
 * Templates = the built-in presets (shared) plus the user's custom resolvers,
 * which are persisted inside settings (`dohCustomTemplates`). The engine itself
 * lives in the torrent host and reads the active URL from settings; this module
 * only owns the list CRUD and a connectivity test for the Settings UI.
 */

import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db/store';
import { BUILTIN_DOH_TEMPLATES, DohTemplate } from '../../shared/types';
import { logger } from '../utils';

const log = logger.child('DoH');

/** Built-in presets + the user's custom resolvers. */
export async function getDohTemplates(): Promise<DohTemplate[]> {
  const s = await db.getSettings();
  const custom = Array.isArray(s.dohCustomTemplates) ? s.dohCustomTemplates : [];
  return [...BUILTIN_DOH_TEMPLATES, ...custom];
}

/** Add a custom resolver. Validates it's an https DoH-JSON-style endpoint. */
export async function addDohTemplate(name: string, url: string): Promise<DohTemplate> {
  const cleanName = (name || '').trim().slice(0, 60) || 'Custom resolver';
  const cleanUrl = (url || '').trim();
  let parsed: URL;
  try { parsed = new URL(cleanUrl); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('DoH endpoint must be https://');

  const s = await db.getSettings();
  const custom = Array.isArray(s.dohCustomTemplates) ? s.dohCustomTemplates : [];
  if (custom.some((t) => t.url === cleanUrl)) throw new Error('That resolver is already in the list');

  const template: DohTemplate = { id: 'custom-' + uuidv4().slice(0, 8), name: cleanName, url: cleanUrl };
  await db.updateSettings({ dohCustomTemplates: [...custom, template] });
  log.info('Custom DoH resolver added', { name: cleanName, host: parsed.host });
  return template;
}

/** Remove a custom resolver. If it was the active one, fall back to a built-in. */
export async function deleteDohTemplate(id: string): Promise<{ ok: boolean }> {
  const s = await db.getSettings();
  const custom = Array.isArray(s.dohCustomTemplates) ? s.dohCustomTemplates : [];
  const next = custom.filter((t) => t.id !== id);
  const patch: Partial<import('../../shared/types.js').AppSettings> = { dohCustomTemplates: next };
  if (s.dohTemplateId === id) patch.dohTemplateId = BUILTIN_DOH_TEMPLATES[0].id;
  await db.updateSettings(patch);
  log.info('Custom DoH resolver removed', { id });
  return { ok: true };
}

/** Probe a resolver by resolving a known host, returning latency + the answer. */
export function testDohResolver(url: string): Promise<{ ok: boolean; ms?: number; ip?: string; error?: string }> {
  return new Promise((resolve) => {
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    if (endpoint.protocol !== 'https:') return resolve({ ok: false, error: 'Must be https://' });
    endpoint.searchParams.set('name', 'example.com');
    endpoint.searchParams.set('type', 'A');

    const started = Date.now();
    const req = https.get(endpoint.toString(), { headers: { accept: 'application/dns-json' }, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: 'HTTP ' + res.statusCode }); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data) as { Answer?: Array<{ type: number; data: string }> };
          const a = (j.Answer || []).find((x) => x.type === 1 && x.data);
          if (!a) return resolve({ ok: false, error: 'No A record in response' });
          resolve({ ok: true, ms: Date.now() - started, ip: a.data });
        } catch { resolve({ ok: false, error: 'Bad response (not DoH JSON)' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
  });
}
