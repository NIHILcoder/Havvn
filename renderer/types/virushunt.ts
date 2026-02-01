/**
 * VirusHunt Component Types
 */

import { ScanResult, FileCategory, ScanProgress } from '../../shared/virushunt-types';

export type ScanMode = 'downloads' | 'folder' | 'file';

export interface VirusHuntSettings {
  deepScan: boolean;
  sensitivity: number; // 0-100
  autoCheck: boolean;
}

export interface ScanState {
  isScanning: boolean;
  scanId: string | null;
  progress: number; // 0-100
  currentFile: string;
  filesScanned: number;
  filesTotal: number;
  results: ScanResult[];
  errors: string[];
}

export interface ScanStatistics {
  totalFiles: number;
  safeFiles: number;
  threatsFound: number;
  cracksFound: number;
  keygensFound: number;
  suspiciousFiles: number;
  dangerousFiles: number;
  unknownFiles: number;
  scannedSize: number; // in bytes
  scanTime: number; // in seconds
}

export interface ThreatBadge {
  category: FileCategory;
  count: number;
  color: string;
  icon: string;
  label: string;
}

export interface ScanModeCard {
  id: ScanMode;
  title: string;
  description: string;
  icon: React.ReactNode;
  available: boolean;
}

export interface VirusHuntError {
  code: string;
  message: string;
  details?: string;
}

export interface ScanRequest {
  mode: ScanMode;
  path?: string;
  settings: VirusHuntSettings;
}

export interface FileResult {
  path: string;
  category: FileCategory;
  riskScore: number;
  threats: string[];
  isWhitelisted: boolean;
  scanDate: Date;
}
