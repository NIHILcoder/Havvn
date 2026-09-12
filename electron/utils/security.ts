/**
 * Security utilities - validators and sanitizers
 * Используется для валидации входных данных из IPC
 */

import crypto from 'crypto';
import path from 'path';

/**
 * Валидация ID торрента (40 hex символов - SHA1 info hash)
 */
export function validateTorrentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{40}$/i.test(id)) {
    throw new Error('Invalid torrent ID format');
  }
}

/**
 * Валидация ID комнаты
 */
export function validateRoomId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    throw new Error('Invalid room ID');
  }

  // Дополнительная проверка на опасные символы
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Room ID contains invalid characters');
  }
}

/**
 * Валидация ID файла в комнате
 */
export function validateFileId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    throw new Error('Invalid file ID');
  }
}

/**
 * Валидация сообщения чата
 */
export function validateChatMessage(text: unknown): asserts text is string {
  if (typeof text !== 'string') {
    throw new Error('Message must be a string');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Message cannot be empty');
  }

  if (text.length > 10000) {
    throw new Error('Message too long (max 10000 characters)');
  }
}

/**
 * Валидация URL трекера
 */
export function validateTrackerUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string') {
    throw new Error('Tracker URL must be a string');
  }

  try {
    const parsed = new URL(url);

    // Разрешенные протоколы для трекеров
    const allowedProtocols = ['http:', 'https:', 'udp:', 'wss:', 'ws:'];
    if (!allowedProtocols.includes(parsed.protocol)) {
      throw new Error(`Protocol ${parsed.protocol} not allowed for trackers`);
    }

    // Блокировка локальных адресов (защита от SSRF)
    const hostname = parsed.hostname.toLowerCase();
    const blockedPatterns = [
      'localhost',
      '127.',
      '192.168.',
      '10.',
      '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
      '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
      '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
      '[::1]',
      '::1',
    ];

    if (blockedPatterns.some(pattern => hostname.startsWith(pattern))) {
      throw new Error('Local tracker URLs are not allowed');
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid tracker URL: ${error.message}`);
    }
    throw new Error('Invalid tracker URL');
  }
}

/**
 * Валидация пути для загрузки (защита от path traversal)
 */
export function validateDownloadPath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    throw new Error('Path must be a string');
  }

  if (filePath.length === 0) {
    throw new Error('Path cannot be empty');
  }

  // Нормализация пути
  const normalized = path.normalize(filePath);

  // Проверка на path traversal
  if (filePath.split(/[\\/]+/).includes('..')) {
    throw new Error('Path traversal detected');
  }

  // Блокировка системных директорий
  const forbiddenPaths = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData\\Microsoft',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library',
    '/var',
  ];

  const resolvedPath = path.resolve(normalized);
  if (forbiddenPaths.some(forbidden => resolvedPath.startsWith(forbidden))) {
    throw new Error('Access to system directory denied');
  }

  return resolvedPath;
}

/**
 * Безопасное сравнение строк (защита от timing attacks)
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Генерация безопасного токена
 */
export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Валидация magnet URI
 */
export function validateMagnetUri(uri: unknown): asserts uri is string {
  if (typeof uri !== 'string') {
    throw new Error('Magnet URI must be a string');
  }

  if (!uri.startsWith('magnet:?')) {
    throw new Error('Invalid magnet URI format');
  }

  // Проверка наличия info hash
  if (!uri.includes('xt=urn:btih:')) {
    throw new Error('Magnet URI must contain info hash (xt=urn:btih:)');
  }
}

/**
 * Валидация порта
 */
export function validatePort(port: unknown): asserts port is number {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new Error('Port must be an integer');
  }

  if (port < 1024 || port > 65535) {
    throw new Error('Port must be between 1024 and 65535');
  }
}

/**
 * Валидация имени файла
 */
export function validateFileName(fileName: unknown): asserts fileName is string {
  if (typeof fileName !== 'string') {
    throw new Error('File name must be a string');
  }

  if (fileName.length === 0) {
    throw new Error('File name cannot be empty');
  }

  if (fileName.length > 255) {
    throw new Error('File name too long (max 255 characters)');
  }

  // Проверка на недопустимые символы
  const invalidChars = /[<>:"|?*\x00-\x1F]/;
  if (invalidChars.test(fileName)) {
    throw new Error('File name contains invalid characters');
  }

  // Проверка на зарезервированные имена Windows
  const reservedNames = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ];

  const baseNameUpper = path.basename(fileName, path.extname(fileName)).toUpperCase();
  if (reservedNames.includes(baseNameUpper)) {
    throw new Error('File name is reserved by system');
  }
}

/** Download records use UUIDs; their IDs are not torrent info hashes. */
export function validateDownloadId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error('Invalid download ID');
  }
}
