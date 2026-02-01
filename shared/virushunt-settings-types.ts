/**
 * VirusHunt Settings Types
 * Complete type definitions for all security settings
 */

/**
 * Main settings interface
 */
export interface VirusHuntSettings {
  // Core
  enabled: boolean;
  autoScanAfterDownload: boolean;
  scanOnlyNewFiles: boolean;
  silentMode: boolean;
  sensitivity: number; // 1-10

  // File Types
  fileTypes: FileTypesSettings;

  // Heuristics
  heuristics: HeuristicsSettings;

  // Databases
  databases: DatabaseSettings;

  // Crowdsourcing
  crowdsourcing: CrowdsourcingSettings;

  // Notifications
  notifications: NotificationSettings;

  // Performance
  performance: PerformanceSettings;

  // Exclusions
  exclusions: ExclusionsSettings;

  // Advanced
  advanced: AdvancedSettings;
}

/**
 * File types configuration
 */
export interface FileTypesSettings {
  executable: boolean;
  archive: boolean;
  script: boolean;
  document: boolean;
  media: boolean;
  customExtensions: string[]; // [".dll", ".sys"]
  exclusionList: string[]; // [".txt", ".jpg"]
}

/**
 * Heuristic rules configuration
 */
export interface HeuristicsSettings {
  enabled: boolean;
  entropyThreshold: number; // 0-8
  suspiciousImportsThreshold: number; // 0-100
  riskScoreThreshold: number; // 0-100
  checkPEStructure: boolean;
  checkEntropy: boolean;
  checkSignatures: boolean;
  checkStrings: boolean;
  checkBehavior: boolean;
  customRulesPath: string;
}

/**
 * Database configuration
 */
export interface DatabaseSettings {
  path: string;
  autoUpdate: boolean;
  updateFrequency: UpdateFrequency;
  lastUpdate: number;
  statistics: DatabaseStatistics;
}

export type UpdateFrequency = 'daily' | 'weekly' | 'monthly' | 'manual';

export interface DatabaseStatistics {
  totalSize: number;
  whitelistCount: number;
  blacklistCount: number;
  releaseGroupsCount: number;
  patternsCount: number;
  lastUpdated: number;
}

/**
 * Crowdsourcing configuration
 */
export interface CrowdsourcingSettings {
  enabled: boolean;
  shareAnonymizedData: boolean;
  contributionStats: ContributionStats;
}

export interface ContributionStats {
  scansShared: number;
  threatsReported: number;
  falsePositivesReported: number;
  reputationScore: number;
}

/**
 * Notification configuration
 */
export interface NotificationSettings {
  enabled: boolean;
  soundEnabled: boolean;
  notificationType: NotificationType;
  priority: NotificationPriority;
  showDesktop: boolean;
  showInApp: boolean;
}

export type NotificationType = 'all' | 'threats-only' | 'critical-only';
export type NotificationPriority = 'low' | 'normal' | 'high';

/**
 * Performance configuration
 */
export interface PerformanceSettings {
  parallelScans: number; // 1-10
  backgroundPriority: boolean;
  scheduledScans: ScheduledScan[];
  maxMemoryUsage: number; // MB
  cpuLimit: number; // percentage
}

export interface ScheduledScan {
  id: string;
  enabled: boolean;
  time: string; // HH:MM
  days: DayOfWeek[];
  targetPath: string;
}

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * Exclusions configuration
 */
export interface ExclusionsSettings {
  paths: ExcludedPath[];
  hashes: string[];
  releaseGroups: string[];
  autoAddTrustedGroups: boolean;
}

export interface ExcludedPath {
  id: string;
  path: string;
  type: 'file' | 'folder';
  reason?: string;
  addedAt: number;
}

/**
 * Advanced configuration
 */
export interface AdvancedSettings {
  debugMode: boolean;
  logPath: string;
  logLevel: LogLevel;
  maxLogSize: number; // MB
  enableTelemetry: boolean;
  customScannerPath?: string;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Default settings
 */
export const DEFAULT_VIRUSHUNT_SETTINGS: VirusHuntSettings = {
  enabled: true,
  autoScanAfterDownload: true,
  scanOnlyNewFiles: false,
  silentMode: false,
  sensitivity: 5,

  fileTypes: {
    executable: true,
    archive: true,
    script: true,
    document: false,
    media: false,
    customExtensions: [],
    exclusionList: ['.txt', '.jpg', '.png', '.mp3', '.mp4'],
  },

  heuristics: {
    enabled: true,
    entropyThreshold: 7.0,
    suspiciousImportsThreshold: 5,
    riskScoreThreshold: 70,
    checkPEStructure: true,
    checkEntropy: true,
    checkSignatures: true,
    checkStrings: true,
    checkBehavior: true,
    customRulesPath: '',
  },

  databases: {
    path: '',
    autoUpdate: true,
    updateFrequency: 'weekly',
    lastUpdate: 0,
    statistics: {
      totalSize: 0,
      whitelistCount: 0,
      blacklistCount: 0,
      releaseGroupsCount: 0,
      patternsCount: 0,
      lastUpdated: 0,
    },
  },

  crowdsourcing: {
    enabled: false,
    shareAnonymizedData: true,
    contributionStats: {
      scansShared: 0,
      threatsReported: 0,
      falsePositivesReported: 0,
      reputationScore: 0,
    },
  },

  notifications: {
    enabled: true,
    soundEnabled: true,
    notificationType: 'threats-only',
    priority: 'normal',
    showDesktop: true,
    showInApp: true,
  },

  performance: {
    parallelScans: 4,
    backgroundPriority: true,
    scheduledScans: [],
    maxMemoryUsage: 512,
    cpuLimit: 50,
  },

  exclusions: {
    paths: [],
    hashes: [],
    releaseGroups: ['CODEX', 'SKIDROW', 'FitGirl'],
    autoAddTrustedGroups: true,
  },

  advanced: {
    debugMode: false,
    logPath: '',
    logLevel: 'info',
    maxLogSize: 100,
    enableTelemetry: true,
  },
};

/**
 * Settings validation result
 */
export interface SettingsValidationResult {
  valid: boolean;
  errors: SettingsValidationError[];
}

export interface SettingsValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Settings update result
 */
export interface SettingsUpdateResult {
  success: boolean;
  message?: string;
  updatedSettings?: VirusHuntSettings;
}
