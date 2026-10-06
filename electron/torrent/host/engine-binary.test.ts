import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveEngineBinary } from './engine-binary';
describe('bundled engine paths', () => {
  it('selects packaged Linux and Windows engines without consulting PATH', () => {
    expect(resolveEngineBinary('linux', 'x64', true, '/app', '/resources')).toBe(path.join('/resources', 'engine/transmission-daemon'));
    expect(resolveEngineBinary('win32', 'x64', true, '/app', '/resources')).toBe(path.join('/resources', 'engine/transmission-daemon.exe'));
    expect(resolveEngineBinary('linux', 'x64', false, '/app', '')).toBe(path.join('/app', 'vendor/transmission/linux-x64/transmission-daemon'));
  });
  it('does not substitute an x64 engine on an unsupported architecture', () => {
    expect(resolveEngineBinary('linux', 'arm64', true, '/app', '/resources')).toBeNull();
    expect(resolveEngineBinary('darwin', 'x64', true, '/app', '/resources')).toBeNull();
  });
});
