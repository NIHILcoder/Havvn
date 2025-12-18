export { logger } from './logger';
export type { LogLevel, ModuleLogger } from './logger';

import fs from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Check available disk space at given path
 * @param targetPath - Path to check (file or directory)
 * @returns Available space in bytes, or null if check fails
 */
export async function checkDiskSpace(targetPath: string): Promise<number | null> {
  try {
    // For Windows, use statfs or fallback to check-disk-space package if needed
    const { statfs } = fs.promises;
    
    // Get the directory path (if file path is provided)
    const dirPath = fs.statSync(targetPath).isDirectory() 
      ? targetPath 
      : path.dirname(targetPath);
    
    // Try using fs.statfs (Node.js 18+)
    if (statfs) {
      const stats = await statfs(dirPath);
      const availableSpace = stats.bavail * stats.bsize;
      return availableSpace;
    }
    
    // Fallback: return null if statfs is not available
    // In production, you might want to use check-disk-space npm package
    return null;
  } catch (error) {
    logger.child('utils').warn('Failed to check disk space', { error, targetPath });
    return null;
  }
}
