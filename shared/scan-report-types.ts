/**
 * Scan Report Types
 * Type definitions for scan reports, history, and export functionality
 */

import { ThreatLevel, FileCategory } from './virushunt-types';

/**
 * Report format types
 */
export type ReportFormat = 'html' | 'json' | 'txt' | 'pdf';

/**
 * Scan result for reporting
 */
export interface ScanResult {
  /** File path */
  path: string;
  /** File name */
  name: string;
  /** File size in bytes */
  size: number;
  /** SHA256 hash */
  hash: string;
  /** File category */
  category: FileCategory;
  /** Threat level */
  threatLevel: ThreatLevel;
  /** Risk score 0-100 */
  riskScore: number;
  /** Threats detected */
  threats: Array<{
    type: string;
    level: ThreatLevel;
    description: string;
    confidence: number;
  }>;
  /** Scan timestamp */
  scannedAt: number;
  /** Reputation status */
  reputation?: 'whitelisted' | 'blacklisted' | 'unknown';
  /** Release group if detected */
  releaseGroup?: string;
  /** Pattern matches */
  patternMatches?: Array<{
    category: string;
    severity: string;
    description: string;
  }>;
}

/**
 * Scan summary statistics
 */
export interface ScanSummary {
  /** Total files scanned */
  totalFiles: number;
  /** Clean files */
  cleanFiles: number;
  /** Suspicious files */
  suspiciousFiles: number;
  /** Dangerous files */
  dangerousFiles: number;
  /** Critical files */
  criticalFiles: number;
  /** Total threats detected */
  totalThreats: number;
  /** Total size scanned */
  totalSize: number;
  /** Scan duration in milliseconds */
  duration: number;
  /** Scan start time */
  startTime: number;
  /** Scan end time */
  endTime: number;
  /** Scanned path */
  scannedPath: string;
}

/**
 * Complete scan report data
 */
export interface ScanReport {
  /** Unique scan ID */
  id: string;
  /** Report version */
  version: string;
  /** Scan summary */
  summary: ScanSummary;
  /** Scan results */
  results: ScanResult[];
  /** Generated at timestamp */
  generatedAt: number;
  /** TorrentHunt version */
  appVersion: string;
  /** System information */
  systemInfo?: {
    platform: string;
    arch: string;
    nodeVersion: string;
  };
}

/**
 * Export options
 */
export interface ExportOptions {
  /** Report format */
  format: ReportFormat;
  /** Output file path */
  outputPath: string;
  /** Include charts in PDF/HTML */
  includeCharts?: boolean;
  /** Theme for HTML/PDF */
  theme?: 'light' | 'dark';
  /** Include system info */
  includeSystemInfo?: boolean;
  /** Anonymize paths */
  anonymizePaths?: boolean;
}

/**
 * Export result
 */
export interface ExportResult {
  /** Success status */
  success: boolean;
  /** Output file path */
  filePath?: string;
  /** File size in bytes */
  fileSize?: number;
  /** Error message if failed */
  error?: string;
  /** Generation duration in ms */
  duration?: number;
}

/**
 * Scan history entry
 */
export interface ScanHistoryEntry {
  /** Unique scan ID */
  id: string;
  /** Scan timestamp */
  timestamp: number;
  /** Scanned path */
  path: string;
  /** Scan summary */
  summary: ScanSummary;
  /** Path to full results JSON */
  resultsPath: string;
  /** Tags for filtering */
  tags?: string[];
  /** User notes */
  notes?: string;
}

/**
 * Scan history database
 */
export interface ScanHistoryDatabase {
  /** Database version */
  version: string;
  /** Last updated timestamp */
  lastUpdated: number;
  /** Scan entries */
  scans: ScanHistoryEntry[];
}

/**
 * History filter options
 */
export interface HistoryFilter {
  /** Filter by date range */
  dateRange?: {
    start: number;
    end: number;
  };
  /** Filter by path pattern */
  pathPattern?: string;
  /** Filter by threat level */
  threatLevel?: ThreatLevel[];
  /** Filter by tags */
  tags?: string[];
  /** Minimum threats count */
  minThreats?: number;
  /** Maximum threats count */
  maxThreats?: number;
}

/**
 * Comparison result between two scans
 */
export interface ComparisonResult {
  /** First scan */
  scan1: ScanHistoryEntry;
  /** Second scan */
  scan2: ScanHistoryEntry;
  /** New threats detected in scan2 */
  newThreats: ScanResult[];
  /** Resolved threats from scan1 */
  resolvedThreats: ScanResult[];
  /** Changed files */
  changedFiles: Array<{
    path: string;
    scan1Result: ScanResult;
    scan2Result: ScanResult;
    changes: string[];
  }>;
  /** New files in scan2 */
  newFiles: ScanResult[];
  /** Removed files from scan1 */
  removedFiles: ScanResult[];
  /** Statistics comparison */
  statsComparison: {
    threatChange: number; // positive = more threats
    cleanFilesChange: number;
    riskScoreChange: number;
  };
}

/**
 * Chart data for statistics visualization
 */
export interface ChartData {
  /** Threat type distribution */
  threatDistribution: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  /** Directory statistics */
  directoryStats: Array<{
    directory: string;
    clean: number;
    suspicious: number;
    dangerous: number;
    critical: number;
  }>;
  /** Scan history timeline */
  scanTimeline: Array<{
    timestamp: number;
    totalThreats: number;
    cleanFiles: number;
    suspiciousFiles: number;
  }>;
  /** File category distribution */
  categoryDistribution: Array<{
    category: FileCategory;
    count: number;
    percentage: number;
  }>;
  /** Risk score heatmap */
  riskHeatmap: Array<{
    path: string;
    score: number;
    level: ThreatLevel;
  }>;
}

/**
 * Report generation progress
 */
export interface ReportProgress {
  /** Current stage */
  stage: 'preparing' | 'generating' | 'rendering' | 'saving' | 'complete';
  /** Progress percentage 0-100 */
  progress: number;
  /** Current status message */
  message: string;
  /** Estimated time remaining in ms */
  estimatedTimeRemaining?: number;
}

/**
 * Share options for community
 */
export interface ShareOptions {
  /** Include file paths */
  includePaths: boolean;
  /** Anonymize file names */
  anonymizeNames: boolean;
  /** Include system info */
  includeSystemInfo: boolean;
  /** Only include threats */
  threatsOnly: boolean;
  /** User email for feedback */
  email?: string;
  /** Additional comments */
  comments?: string;
}

/**
 * Anonymized scan data for sharing
 */
export interface AnonymizedScanData {
  /** Scan ID (anonymized) */
  scanId: string;
  /** Summary statistics */
  summary: Omit<ScanSummary, 'scannedPath'>;
  /** Anonymized results */
  results: Array<{
    hash: string;
    category: FileCategory;
    threatLevel: ThreatLevel;
    riskScore: number;
    threats: ScanResult['threats'];
  }>;
  /** Timestamp */
  timestamp: number;
}
