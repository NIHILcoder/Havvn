/**
 * ScanResults Component Types
 */

import { FileCategory, FileScanResult, AdvancedHeuristicResult } from '../../shared/virushunt-types';

export interface ScanResultRow extends FileScanResult {
  id: string;
  directory: string;
  formattedSize: string;
  categoryLabel: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  selected?: boolean;
  // Extended properties from AdvancedHeuristicResult
  category?: FileCategory;
  riskScore?: number;
  assessment?: string;
  peAnalysis?: AdvancedHeuristicResult['peAnalysis'];
  entropyAnalysis?: AdvancedHeuristicResult['entropyAnalysis'];
  signatureVerification?: AdvancedHeuristicResult['signatureVerification'];
  stringAnalysis?: AdvancedHeuristicResult['stringAnalysis'];
  matches?: AdvancedHeuristicResult['matches'];
  reasons?: string[];
  isLegitCrack?: boolean;
  releaseGroup?: string;
  scanDate?: number;
  // Reputation flags
  isWhitelisted?: boolean;
  isBlacklisted?: boolean;
}

export interface ScanResultFilters {
  search: string;
  categories: FileCategory[];
  riskScoreMin: number;
  riskScoreMax: number;
  showWhitelisted: boolean;
  showBlacklisted: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
  column: keyof ScanResultRow;
  direction: SortDirection;
}

export interface ColumnConfig {
  id: keyof ScanResultRow;
  header: string;
  width: number;
  minWidth: number;
  maxWidth?: number;
  sortable: boolean;
  resizable: boolean;
}

export interface BulkAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  variant: 'default' | 'danger' | 'warning';
  confirm?: boolean;
  confirmMessage?: string;
  action: (rows: ScanResultRow[]) => Promise<void>;
}

export interface ExportFormat {
  format: 'json' | 'txt' | 'html' | 'csv';
  label: string;
  icon: React.ReactNode;
}

export interface DetailTab {
  id: string;
  label: string;
  icon: React.ReactNode;
}

export interface ThreatDetails {
  ruleId: string;
  ruleName: string;
  description: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  evidence: string[];
  mitigation?: string;
}

export interface TechnicalDetails {
  peAnalysis?: {
    architecture: string;
    entryPoint: string;
    sections: Array<{
      name: string;
      entropy: number;
      isExecutable: boolean;
      isWritable: boolean;
    }>;
    imports: Array<{
      dll: string;
      functions: string[];
    }>;
    suspiciousImports: string[];
  };
  entropyAnalysis?: {
    fileEntropy: number;
    isPacked: boolean;
    assessment: string;
  };
  signatureVerification?: {
    isSigned: boolean;
    isValid: boolean;
    signer?: string;
    subject?: string;
    issuer?: string;
  };
  stringAnalysis?: {
    suspiciousUrls: string[];
    ipAddresses: string[];
    miningPools: string[];
    c2Indicators: string[];
    registryKeys: string[];
  };
}

export interface ScanResultModalData {
  result: ScanResultRow;
  threats: ThreatDetails[];
  technical: TechnicalDetails;
  expectedBehavior?: string[];
  maliciousBehavior?: string[];
}

export interface TableState {
  filters: ScanResultFilters;
  sort: SortConfig;
  selectedRows: Set<string>;
  visibleColumns: Set<keyof ScanResultRow>;
  columnWidths: Map<keyof ScanResultRow, number>;
}

export interface ExportOptions {
  format: ExportFormat['format'];
  includeSelected: boolean;
  includeFiltered: boolean;
  fields: Array<keyof ScanResultRow>;
}
