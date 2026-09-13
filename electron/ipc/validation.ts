/**
 * IPC input validation schemas using Zod
 * Provides type-safe validation for all IPC handler inputs
 */

import { z } from 'zod';
import path from 'path';

// Maximum sizes to prevent DoS attacks
export const MAX_CHAT_LENGTH = 10000; // 10KB
export const MAX_PATH_LENGTH = 500;
export const MAX_CATEGORY_NAME = 100;
export const MAX_TORRENT_NAME = 500;
export const MAX_FEED_URL_LENGTH = 2048;

// Path validation: prevent path traversal
const SafePathSchema = z.string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((p) => {
    const normalized = path.normalize(p);
    // Reject paths with .. (traversal) or starting with / (absolute paths on Unix)
    return !normalized.includes('..') && !path.isAbsolute(normalized);
  }, 'Invalid path: path traversal or absolute paths not allowed');

// Safe file path for downloads
const DownloadDirSchema = z.string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((p) => {
    const normalized = path.normalize(p);
    // Must be absolute path for download directory
    return path.isAbsolute(normalized) && !normalized.includes('..');
  }, 'Invalid download directory');

// Magnet URI validation
const MagnetUriSchema = z.string()
  .startsWith('magnet:?', 'Invalid magnet URI')
  .max(10000); // Reasonable limit for magnet URIs

// Torrent file path validation
const TorrentPathSchema = z.string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((p) => {
    return p.endsWith('.torrent') && !p.includes('..');
  }, 'Invalid torrent file path');

// Room ID validation (hex string, 32 chars)
const RoomIdSchema = z.string()
  .regex(/^[a-f0-9]{32}$/, 'Invalid room ID format');

// Member ID validation (hex string, 32 chars)
const MemberIdSchema = z.string()
  .regex(/^[a-f0-9]{32}$/, 'Invalid member ID format');

// Downloads validation schemas
export const AddDownloadSchema = z.object({
  magnetUri: MagnetUriSchema.optional(),
  torrentPath: TorrentPathSchema.optional(),
  downloadDir: DownloadDirSchema,
  paused: z.boolean().optional(),
  category: z.string().max(MAX_CATEGORY_NAME).nullable().optional(),
}).refine(
  (data) => data.magnetUri || data.torrentPath,
  'Either magnetUri or torrentPath must be provided'
);

export const DownloadIdSchema = z.string()
  .min(1)
  .max(100);

export const RemoveDownloadSchema = z.object({
  id: DownloadIdSchema,
  deleteFiles: z.boolean(),
});

export const GetStreamUrlSchema = z.object({
  id: DownloadIdSchema,
  fileIndex: z.number().int().min(0),
  opts: z.object({
    transcode: z.boolean().optional(),
    audioTrack: z.number().int().min(0).optional(),
  }).optional(),
});

// Settings validation schemas
export const SettingsSchema = z.object({
  defaultDownloadDir: z.string().max(MAX_PATH_LENGTH).optional(),
  maxDownloadSpeed: z.number().min(0).max(1_000_000).optional(), // KB/s, max 1GB/s
  maxUploadSpeed: z.number().min(0).max(1_000_000).optional(),
  maxConnections: z.number().int().min(1).max(1000).optional(),
  portForwarding: z.boolean().optional(),
  dhtEnabled: z.boolean().optional(),
  pexEnabled: z.boolean().optional(),
  ltpEnabled: z.boolean().optional(), // µTP
  closeToTray: z.boolean().optional(),
  minimizeToTray: z.boolean().optional(),
  autoLaunch: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
  theme: z.enum(['light', 'dark', 'auto']).optional(),
  language: z.enum(['en', 'ru']).optional(),
}).passthrough(); // Allow other fields

// Category validation schemas
export const CategorySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(MAX_CATEGORY_NAME),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid color format'),
  icon: z.string().max(50).optional(),
  downloadDir: z.string().max(MAX_PATH_LENGTH).optional(),
});

export const UpdateCategorySchema = z.object({
  id: z.string().uuid(),
  updates: CategorySchema.partial(),
});

// Room validation schemas
export const CreateRoomSchema = z.object({
  name: z.string().min(1).max(100),
  e2e: z.boolean().optional(),
});

export const JoinRoomSchema = z.object({
  invite: z.string().min(10).max(200),
});

export const SendChatSchema = z.object({
  roomId: RoomIdSchema,
  text: z.string().min(1).max(MAX_CHAT_LENGTH),
  replyTo: z.string().optional(),
});

export const EditChatSchema = z.object({
  roomId: RoomIdSchema,
  msgId: z.string().uuid(),
  text: z.string().min(1).max(MAX_CHAT_LENGTH),
});

export const RoomFileSchema = z.object({
  roomId: RoomIdSchema,
  fileId: z.string().uuid(),
});

export const SetMutedSchema = z.object({
  roomId: RoomIdSchema,
  memberId: MemberIdSchema,
  muted: z.boolean(),
});

export const KickMemberSchema = z.object({
  roomId: RoomIdSchema,
  memberId: MemberIdSchema,
});

export const TransferOwnerSchema = z.object({
  roomId: RoomIdSchema,
  memberId: MemberIdSchema,
});

export const SetLimitsSchema = z.object({
  roomId: RoomIdSchema,
  upKbps: z.number().int().min(0).max(100_000), // Max 100 MB/s
  downKbps: z.number().int().min(0).max(100_000),
});

// RSS validation schemas
export const AddFeedSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(MAX_FEED_URL_LENGTH),
  interval: z.number().int().min(15).max(1440).optional(), // 15 min to 24 hours
  enabled: z.boolean().optional(),
});

export const UpdateFeedSchema = z.object({
  id: z.string().uuid(),
  updates: AddFeedSchema.partial(),
});

// Search provider validation
export const AddSearchProviderSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url().max(MAX_FEED_URL_LENGTH),
  enabled: z.boolean().optional(),
  apiKey: z.string().max(500).optional(),
});

// IP Blocklist validation
export const AddBlocklistSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url().max(MAX_FEED_URL_LENGTH),
  enabled: z.boolean().optional(),
});

// Scheduler validation
export const SchedulerConfigSchema = z.object({
  enabled: z.boolean(),
  rules: z.array(z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(100),
    enabled: z.boolean(),
    schedule: z.object({
      type: z.enum(['time', 'interval', 'cron']),
      value: z.string().min(1).max(100),
    }),
    action: z.object({
      type: z.enum(['pause', 'resume', 'setSpeed', 'quit']),
      params: z.record(z.any()).optional(),
    }),
  })),
});

// Validation helper function
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Validation error: ${messages}`);
    }
    throw error;
  }
}

// System directory detection (prevent downloads to system folders)
export function isSystemDirectory(dir: string): boolean {
  const normalized = path.normalize(dir).toLowerCase();

  // Windows system directories
  const windowsSystem = [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users\\all users',
  ];

  // Unix system directories
  const unixSystem = [
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/etc',
    '/sys',
    '/proc',
    '/dev',
    '/root',
    '/boot',
    '/lib',
    '/lib64',
  ];

  const systemDirs = process.platform === 'win32' ? windowsSystem : unixSystem;

  return systemDirs.some(sysDir => normalized.startsWith(sysDir));
}
