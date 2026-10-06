import path from 'node:path';

/** Resolve only a bundled engine; never start an unrelated daemon from PATH. */
export function resolveEngineBinary(platform: NodeJS.Platform, arch: string, packaged: boolean,
  appPath: string, resourcesPath: string): string | null {
  if (arch !== 'x64' || (platform !== 'win32' && platform !== 'linux')) return null;
  const executable = platform === 'win32' ? 'transmission-daemon.exe' : 'transmission-daemon';
  return packaged ? path.join(resourcesPath, 'engine', executable)
    : path.join(appPath, 'vendor', 'transmission', `${platform}-${arch}`, executable);
}
