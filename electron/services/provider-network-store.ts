import Store from 'electron-store';
import { randomUUID } from 'node:crypto';
import type { ProviderAccess, SearchNetworkProfile, SearchNetworkSettings } from '../../shared/provider-network';
import { parseProviderConnection, providerUrl } from '../../shared/provider-network';

const settings = new Store<SearchNetworkSettings>({ name: 'search-connections', defaults: { profiles: [], access: {} } });
export function getSearchNetworkSettings(): SearchNetworkSettings {
  return { profiles: settings.get('profiles'), access: settings.get('access') };
}
export function saveSearchNetworkProfile(input: Omit<SearchNetworkProfile, 'id'> & { id?: string }): SearchNetworkProfile {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Invalid connection name');
  const profiles = settings.get('profiles');
  const index = input.id ? profiles.findIndex(p => p.id === input.id) : -1;
  if (input.id && index < 0) throw new Error('Connection not found');
  if (!input.id && profiles.length >= 50) throw new Error('Too many search connections');
  const profile = { id: input.id || randomUUID(), name: input.name.trim(), connection: parseProviderConnection(input.connection) };
  if (index < 0) profiles.push(profile); else profiles[index] = profile;
  settings.set('profiles', profiles);
  return profile;
}
export function setProviderAccess(providerId: string, input: ProviderAccess | null): void {
  if (typeof providerId !== 'string' || providerId.length > 100) throw new Error('Invalid provider');
  const access = settings.get('access');
  if (input === null) { delete access[providerId]; settings.set('access', access); return; }
  if (!['direct', 'system'].includes(input.profileId) && !settings.get('profiles').some(p => p.id === input.profileId)) throw new Error('Connection not found');
  if (!Array.isArray(input.origins) || input.origins.length > 20) throw new Error('Invalid trusted origins');
  const origins = [...new Set(input.origins.map(value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid trusted origin');
    const url = new URL(value);
    providerUrl(value, [url.origin]);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Specify origins without paths');
    return url.origin;
  }))];
  if (input.mirrors !== undefined && (!Array.isArray(input.mirrors) || input.mirrors.length > 10)) throw new Error('Invalid mirrors');
  const mirrors = [...new Set((input.mirrors ?? []).map(value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid mirror');
    const url = new URL(value);
    providerUrl(value, [url.origin]);
    if (url.search || url.hash) throw new Error('Mirror must not contain a query or fragment');
    return url.href.replace(/\/$/, '');
  }))];
  const previousMirror = access[providerId]?.lastWorkingMirror;
  access[providerId] = { profileId: input.profileId, origins: [...new Set([...origins, ...mirrors.map(m => new URL(m).origin)])], mirrors,
    ...(previousMirror && mirrors.includes(previousMirror) ? { lastWorkingMirror: previousMirror } : {}),
  };
  settings.set('access', access);
}
export function getProviderRoute(providerId: string) {
  const access: ProviderAccess | undefined = settings.get('access')[providerId];
  if (!access) return null; // legacy HTTP/Python behavior remains explicit
  const profile = settings.get('profiles').find(p => p.id === access.profileId);
  const connection = access.profileId === 'direct' ? { mode: 'direct' as const } :
    access.profileId === 'system' ? { mode: 'system' as const } : profile?.connection;
  if (!connection) throw new Error('Search connection no longer exists');
  const mirrors = [...(access.mirrors ?? [])];
  if (access.lastWorkingMirror && mirrors.includes(access.lastWorkingMirror)) {
    mirrors.splice(mirrors.indexOf(access.lastWorkingMirror), 1); mirrors.unshift(access.lastWorkingMirror);
  }
  return { connection, origins: access.origins, mirrors };
}

export function rememberProviderMirror(providerId: string, mirror: string): void {
  const access = settings.get('access');
  if (!access[providerId]?.mirrors?.includes(mirror) || access[providerId].lastWorkingMirror === mirror) return;
  access[providerId].lastWorkingMirror = mirror;
  settings.set('access', access);
}

export function clearSearchNetworkSettings(): void { settings.clear(); }
