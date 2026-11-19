import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AddDownloadRequest, AppSettings, Category } from '../../shared/types';
import { applyDownloadDefaults, validateDownloadDefaults } from '../../shared/category-defaults';
import { validateDownloadPath } from '../utils/security';

/** Runs in main for every caller of the manager, including RSS/watch-folder/remote. */
export async function prepareDownloadDefaults(request: AddDownloadRequest, categories: Category[], settings: AppSettings): Promise<AddDownloadRequest> {
  if (request.categoryId !== undefined && typeof request.categoryId !== 'string') throw new Error('Invalid category ID');
  const category = categories.find(item => item.id === request.categoryId);
  if (request.categoryId && !category) throw new Error('Category no longer exists');
  if (category?.downloadDefaults) validateDownloadDefaults(category.downloadDefaults);
  const resolved = applyDownloadDefaults(request, category, settings);
  if (!path.isAbsolute(resolved.savePath!)) throw new Error('Download directory must be an absolute path');
  resolved.savePath = validateDownloadPath(resolved.savePath);
  try {
    await fs.mkdir(resolved.savePath, { recursive: true });
    const stat = await fs.stat(resolved.savePath);
    if (!stat.isDirectory()) throw new Error('Not a directory');
    await fs.access(resolved.savePath, constants.W_OK);
  } catch { throw new Error(`Download directory is unavailable: ${resolved.savePath}`); }
  return resolved;
}
