/**
 * VirusHunt Settings Validation Schema
 * Zod schemas for complete settings validation
 */

import { z } from 'zod';

// Day of week schema
export const dayOfWeekSchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

// Update frequency schema
export const updateFrequencySchema = z.enum(['daily', 'weekly', 'monthly', 'manual']);

// Notification type schema
export const notificationTypeSchema = z.enum(['all', 'threats-only', 'critical-only']);

// Notification priority schema
export const notificationPrioritySchema = z.enum(['low', 'normal', 'high']);

// Log level schema
export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);

// File types settings schema
export const fileTypesSettingsSchema = z.object({
  executable: z.boolean(),
  archive: z.boolean(),
  script: z.boolean(),
  document: z.boolean(),
  media: z.boolean(),
  customExtensions: z.array(z.string().regex(/^\.[a-zA-Z0-9]+$/, 'Invalid extension format')),
  exclusionList: z.array(z.string().regex(/^\.[a-zA-Z0-9]+$/, 'Invalid extension format')),
});

// Heuristics settings schema
export const heuristicsSettingsSchema = z.object({
  enabled: z.boolean(),
  entropyThreshold: z.number().min(0).max(8),
  suspiciousImportsThreshold: z.number().min(0).max(100),
  riskScoreThreshold: z.number().min(0).max(100),
  checkPEStructure: z.boolean(),
  checkEntropy: z.boolean(),
  checkSignatures: z.boolean(),
  checkStrings: z.boolean(),
  checkBehavior: z.boolean(),
  customRulesPath: z.string(),
});

// Database statistics schema
export const databaseStatisticsSchema = z.object({
  totalSize: z.number().min(0),
  whitelistCount: z.number().min(0),
  blacklistCount: z.number().min(0),
  releaseGroupsCount: z.number().min(0),
  patternsCount: z.number().min(0),
  lastUpdated: z.number().min(0),
});

// Database settings schema
export const databaseSettingsSchema = z.object({
  path: z.string(),
  autoUpdate: z.boolean(),
  updateFrequency: updateFrequencySchema,
  lastUpdate: z.number().min(0),
  statistics: databaseStatisticsSchema,
});

// Contribution stats schema
export const contributionStatsSchema = z.object({
  scansShared: z.number().min(0),
  threatsReported: z.number().min(0),
  falsePositivesReported: z.number().min(0),
  reputationScore: z.number().min(0).max(100),
});

// Crowdsourcing settings schema
export const crowdsourcingSettingsSchema = z.object({
  enabled: z.boolean(),
  shareAnonymizedData: z.boolean(),
  contributionStats: contributionStatsSchema,
});

// Notification settings schema
export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  soundEnabled: z.boolean(),
  notificationType: notificationTypeSchema,
  priority: notificationPrioritySchema,
  showDesktop: z.boolean(),
  showInApp: z.boolean(),
});

// Scheduled scan schema
export const scheduledScanSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Invalid time format (HH:MM)'),
  days: z.array(dayOfWeekSchema).min(1, 'At least one day must be selected'),
  targetPath: z.string().min(1, 'Target path is required'),
});

// Performance settings schema
export const performanceSettingsSchema = z.object({
  parallelScans: z.number().min(1).max(10),
  backgroundPriority: z.boolean(),
  scheduledScans: z.array(scheduledScanSchema),
  maxMemoryUsage: z.number().min(128).max(4096),
  cpuLimit: z.number().min(10).max(100),
});

// Excluded path schema
export const excludedPathSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1, 'Path is required'),
  type: z.enum(['file', 'folder']),
  reason: z.string().optional(),
  addedAt: z.number().min(0),
});

// Exclusions settings schema
export const exclusionsSettingsSchema = z.object({
  paths: z.array(excludedPathSchema),
  hashes: z.array(z.string().length(64, 'Hash must be 64 characters (SHA256)')),
  releaseGroups: z.array(z.string().min(1)),
  autoAddTrustedGroups: z.boolean(),
});

// Advanced settings schema
export const advancedSettingsSchema = z.object({
  debugMode: z.boolean(),
  logPath: z.string(),
  logLevel: logLevelSchema,
  maxLogSize: z.number().min(1).max(1000),
  enableTelemetry: z.boolean(),
  customScannerPath: z.string().optional(),
});

// Main VirusHunt settings schema
export const virusHuntSettingsSchema = z.object({
  enabled: z.boolean(),
  autoScanAfterDownload: z.boolean(),
  scanOnlyNewFiles: z.boolean(),
  silentMode: z.boolean(),
  sensitivity: z.number().min(1).max(10),
  fileTypes: fileTypesSettingsSchema,
  heuristics: heuristicsSettingsSchema,
  databases: databaseSettingsSchema,
  crowdsourcing: crowdsourcingSettingsSchema,
  notifications: notificationSettingsSchema,
  performance: performanceSettingsSchema,
  exclusions: exclusionsSettingsSchema,
  advanced: advancedSettingsSchema,
});

// Infer TypeScript types from schemas
export type VirusHuntSettingsInput = z.input<typeof virusHuntSettingsSchema>;
export type VirusHuntSettingsOutput = z.output<typeof virusHuntSettingsSchema>;

// Partial update schema (all fields optional for updates)
export const virusHuntSettingsUpdateSchema = virusHuntSettingsSchema.partial();

// Helper function to validate settings
export function validateVirusHuntSettings(settings: unknown) {
  return virusHuntSettingsSchema.safeParse(settings);
}

// Helper function to validate partial update
export function validateVirusHuntSettingsUpdate(updates: unknown) {
  return virusHuntSettingsUpdateSchema.safeParse(updates);
}
