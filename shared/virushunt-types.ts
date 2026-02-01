/**
 * VirusHunt Module Types
 * Type definitions for the VirusHunt security scanning module
 */

/**
 * Threat severity levels
 */
export enum ThreatLevel {
  SAFE = 'safe',
  SUSPICIOUS = 'suspicious',
  DANGEROUS = 'dangerous',
  CRITICAL = 'critical'
}

/**
 * Scan status
 */
export enum ScanStatus {
  IDLE = 'idle',
  SCANNING = 'scanning',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed'
}

/**
 * File reputation status
 */
export enum ReputationStatus {
  WHITELISTED = 'whitelisted',
  BLACKLISTED = 'blacklisted',
  UNKNOWN = 'unknown',
  SUSPICIOUS = 'suspicious'
}

/**
 * Information about detected threat
 */
export interface ThreatInfo {
  /** Type of threat detected */
  type: 'hash_blacklist' | 'heuristic' | 'suspicious_extension' | 'signature' | 'unknown';
  /** Threat severity level */
  level: ThreatLevel;
  /** Human-readable threat description */
  description: string;
  /** Additional details about the threat */
  details?: string;
  /** Confidence score (0-100) */
  confidence: number;
  /** Timestamp when threat was detected */
  detectedAt: number;
}

/**
 * File category for smart classification
 */
export enum FileCategory {
  SAFE = 'safe',
  CRACK = 'crack',
  KEYGEN = 'keygen',
  SUSPICIOUS = 'suspicious',
  DANGEROUS = 'dangerous',
  UNKNOWN = 'unknown'
}

/**
 * PE file analysis result
 */
export interface PEAnalysisResult {
  /** Whether file is valid PE */
  isValidPE: boolean;
  /** PE architecture (x86, x64) */
  architecture?: 'x86' | 'x64';
  /** Entry point address */
  entryPoint?: number;
  /** Imported DLLs and functions */
  imports?: {
    dll: string;
    functions: string[];
  }[];
  /** Exported functions */
  exports?: string[];
  /** PE sections */
  sections?: {
    name: string;
    virtualSize: number;
    rawSize: number;
    entropy: number;
    isExecutable: boolean;
    isWritable: boolean;
  }[];
  /** Suspicious imports detected */
  suspiciousImports?: string[];
  /** Timestamp */
  timestamp?: number;
  /** Linker version */
  linkerVersion?: string;
}

/**
 * Entropy analysis result
 */
export interface EntropyAnalysis {
  /** Overall file entropy (0-8) */
  fileEntropy: number;
  /** Whether file is packed/encrypted */
  isPacked: boolean;
  /** Section entropy details */
  sections?: {
    name: string;
    entropy: number;
    suspicious: boolean;
  }[];
}

/**
 * Digital signature verification result
 */
export interface SignatureVerification {
  /** Whether signature is present */
  isSigned: boolean;
  /** Whether signature is valid */
  isValid: boolean;
  /** Signer name */
  signer?: string;
  /** Certificate subject */
  subject?: string;
  /** Certificate issuer */
  issuer?: string;
  /** Signature timestamp */
  timestamp?: number;
  /** Verification error if any */
  error?: string;
}

/**
 * String analysis result
 */
export interface StringAnalysis {
  /** Suspicious URLs found */
  suspiciousUrls: string[];
  /** Mining pool domains */
  miningPools: string[];
  /** C&C server indicators */
  c2Indicators: string[];
  /** IP addresses found */
  ipAddresses: string[];
  /** Suspicious strings */
  suspiciousStrings: string[];
  /** Registry keys mentioned */
  registryKeys: string[];
}

/**
 * Heuristic analysis match result
 */
export interface HeuristicMatch {
  /** Rule identifier */
  ruleId: string;
  /** Rule name */
  ruleName: string;
  /** Match description */
  description: string;
  /** Severity level */
  severity: ThreatLevel;
  /** Confidence score (0-100) */
  confidence: number;
  /** File offset where match was found */
  offset?: number;
  /** Matched pattern or signature */
  matchedPattern?: string;
  /** Additional evidence */
  evidence?: string[];
}

/**
 * Advanced heuristic analysis result
 */
export interface AdvancedHeuristicResult {
  /** File category */
  category: FileCategory;
  /** Risk score (0-100) */
  riskScore: number;
  /** Overall assessment */
  assessment: string;
  /** PE analysis (if applicable) */
  peAnalysis?: PEAnalysisResult;
  /** Entropy analysis */
  entropyAnalysis?: EntropyAnalysis;
  /** Signature verification */
  signatureVerification?: SignatureVerification;
  /** String analysis */
  stringAnalysis?: StringAnalysis;
  /** Heuristic matches */
  matches: HeuristicMatch[];
  /** Reasons for classification */
  reasons: string[];
  /** Whether file is legitimate crack/keygen */
  isLegitCrack: boolean;
  /** Release group identified */
  releaseGroup?: string;
}

// ===== DEEP ANALYSIS TYPES =====

/**
 * YARA rule match result
 */
export interface YaraMatch {
  /** Rule identifier */
  ruleId: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description: string;
  /** Tags associated with rule */
  tags: string[];
  /** Matched strings with offsets */
  matches: {
    identifier: string;
    offset: number;
    data: string;
  }[];
}

/**
 * API behavior categories for import table analysis
 */
export enum ApiBehavior {
  PROCESS_INJECTION = 'process_injection',
  MEMORY_MANIPULATION = 'memory_manipulation',
  CODE_INJECTION = 'code_injection',
  PROCESS_MANIPULATION = 'process_manipulation',
  KEYLOGGING = 'keylogging',
  SCREEN_CAPTURE = 'screen_capture',
  NETWORK_COMMUNICATION = 'network_communication',
  FILE_SYSTEM = 'file_system',
  REGISTRY_MANIPULATION = 'registry_manipulation',
  SERVICE_MANIPULATION = 'service_manipulation',
  ANTI_DEBUG = 'anti_debug',
  ANTI_ANALYSIS = 'anti_analysis',
  CREDENTIAL_ACCESS = 'credential_access',
  PRIVILEGE_ESCALATION = 'privilege_escalation',
  PERSISTENCE = 'persistence',
  CRYPTO_OPERATIONS = 'crypto_operations',
  CLIPBOARD_ACCESS = 'clipboard_access',
  BROWSER_INTERACTION = 'browser_interaction',
  SHELL_EXECUTION = 'shell_execution'
}

/**
 * Import table analysis result
 */
export interface ImportAnalysisResult {
  /** Total number of imported functions */
  totalImports: number;
  /** Total number of imported DLLs */
  totalDlls: number;
  /** List of imported DLLs with functions */
  dlls: {
    name: string;
    functions: string[];
  }[];
  /** Suspicious APIs detected */
  suspiciousApis: {
    dll: string;
    function: string;
    behavior: ApiBehavior;
    description: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
  }[];
  /** Detected malicious patterns */
  maliciousPatterns: {
    name: string;
    description: string;
    matchedApis: string[];
    confidence: number;
  }[];
  /** Overall risk score for imports */
  riskScore: number;
  /** Human-readable assessment */
  assessment: string;
}

/**
 * Packer detection result
 */
export interface PackerDetectionResult {
  /** Whether packing was detected */
  isPacked: boolean;
  /** Detected packer name(s) */
  packers: {
    name: string;
    confidence: number;
    version?: string;
  }[];
  /** Whether file was successfully unpacked */
  unpacked: boolean;
  /** Path to unpacked file (if unpacked) */
  unpackedPath?: string;
  /** Unpacking error (if failed) */
  unpackError?: string;
  /** Section anomalies detected */
  sectionAnomalies: string[];
  /** Overall packer assessment */
  assessment: string;
}

/**
 * String signature categories
 */
export enum StringCategory {
  URL = 'url',
  IP_ADDRESS = 'ip_address',
  DOMAIN = 'domain',
  EMAIL = 'email',
  CRYPTO_WALLET = 'crypto_wallet',
  REGISTRY_KEY = 'registry_key',
  FILE_PATH = 'file_path',
  SHELL_COMMAND = 'shell_command',
  BASE64_ENCODED = 'base64_encoded',
  HEX_ENCODED = 'hex_encoded',
  C2_INDICATOR = 'c2_indicator',
  MINING_POOL = 'mining_pool',
  CREDENTIAL_PATH = 'credential_path',
  DARKWEB = 'darkweb',
  OTHER = 'other'
}

/**
 * String signature analysis result
 */
export interface StringSignatureResult {
  /** Total strings extracted */
  totalStrings: number;
  /** Suspicious strings found */
  suspiciousStrings: {
    value: string;
    category: StringCategory;
    description: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
  }[];
  /** Category summary */
  categorySummary: {
    category: StringCategory;
    count: number;
  }[];
  /** Overall risk score for strings */
  riskScore: number;
  /** Human-readable assessment */
  assessment: string;
}

/**
 * Deep analysis result combining all advanced analyzers
 */
export interface DeepAnalysisResult extends AdvancedHeuristicResult {
  /** YARA rule matches */
  yaraMatches: YaraMatch[];
  /** Import table analysis */
  importAnalysis?: ImportAnalysisResult;
  /** Packer detection result */
  packerDetection?: PackerDetectionResult;
  /** String signature analysis */
  stringSignatures?: StringSignatureResult;
  /** Combined deep risk score */
  deepRiskScore: number;
  /** Overall deep assessment */
  deepAssessment: string;
  /** Analysis duration in ms */
  analysisDuration?: number;
}

/**
 * File reputation information
 */
export interface FileReputation {
  /** File hash (SHA256) */
  hash: string;
  /** Reputation status */
  status: ReputationStatus;
  /** File size in bytes */
  size: number;
  /** Optional file name */
  fileName?: string;
  /** When this reputation was last updated */
  lastUpdated: number;
  /** Source of reputation data */
  source: 'database' | 'heuristic' | 'manual';
  /** Additional metadata */
  metadata?: {
    /** Release group name */
    releaseGroup?: string;
    /** Known good file marker */
    verified?: boolean;
    /** Number of reports */
    reportCount?: number;
  };
}

/**
 * Individual file scan result
 */
export interface FileScanResult {
  /** Absolute file path */
  filePath: string;
  /** File name */
  fileName: string;
  /** File size in bytes */
  size: number;
  /** File hash (SHA256) */
  hash: string;
  /** Overall threat level */
  threatLevel: ThreatLevel;
  /** Reputation status */
  reputation: ReputationStatus;
  /** List of detected threats */
  threats: ThreatInfo[];
  /** Heuristic analysis matches */
  heuristicMatches: HeuristicMatch[];
  /** Whether file is safe to use */
  isSafe: boolean;
  /** Scan duration in milliseconds */
  scanDuration: number;
  /** Timestamp when scan was performed */
  scannedAt: number;
}

/**
 * Complete scan result for multiple files
 */
export interface ScanResult {
  /** Unique scan ID */
  scanId: string;
  /** Overall scan status */
  status: ScanStatus;
  /** Total number of files scanned */
  totalFiles: number;
  /** Number of files scanned so far */
  scannedFiles: number;
  /** Number of threats detected */
  threatsDetected: number;
  /** Number of safe files */
  safeFiles: number;
  /** Number of suspicious files */
  suspiciousFiles: number;
  /** Individual file results */
  fileResults: FileScanResult[];
  /** Scan start timestamp */
  startedAt: number;
  /** Scan completion timestamp (if completed) */
  completedAt?: number;
  /** Total scan duration in milliseconds */
  duration?: number;
  /** Error message if scan failed */
  error?: string;
}

/**
 * Scan progress update
 */
export interface ScanProgress {
  /** Scan ID */
  scanId: string;
  /** Current file being scanned */
  currentFile: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Number of files scanned */
  scannedFiles: number;
  /** Total files to scan */
  totalFiles: number;
  /** Number of threats found so far */
  threatsFound: number;
}

/**
 * VirusHunt configuration
 */
export interface VirusHuntConfig {
  /** Enable/disable scanning */
  enabled: boolean;
  /** Enable heuristic analysis */
  enableHeuristics: boolean;
  /** Enable automatic database updates */
  autoUpdateDatabase: boolean;
  /** Database update interval in hours */
  updateInterval: number;
  /** Maximum file size to scan in bytes (0 = unlimited) */
  maxFileSizeToScan: number;
  /** Scan timeout per file in milliseconds */
  scanTimeout: number;
  /** File extensions to skip (e.g., ['.txt', '.jpg']) */
  skipExtensions: string[];
  /** Automatically quarantine dangerous files */
  autoQuarantine: boolean;
  /** Quarantine directory path */
  quarantinePath?: string;
  /** Enable real-time protection */
  realTimeProtection: boolean;
  /** Scan newly added torrents automatically */
  scanNewTorrents: boolean;
  /** Log scan results */
  enableLogging: boolean;
}

/**
 * Database version information
 */
export interface DatabaseVersion {
  /** Version number (semantic versioning) */
  version: string;
  /** Last update timestamp */
  lastUpdated: number;
  /** Number of entries in database */
  entryCount: number;
  /** Database checksum */
  checksum?: string;
}

/**
 * Hash database structure
 */
export interface HashDatabase {
  /** Database metadata */
  metadata: {
    version: string;
    lastUpdated: number;
    description: string;
  };
  /** Whitelisted file hashes */
  whitelist: {
    [hash: string]: {
      fileName?: string;
      size?: number;
      addedAt: number;
      source?: string;
    };
  };
  /** Blacklisted file hashes */
  blacklist: {
    [hash: string]: {
      fileName?: string;
      threatType: string;
      severity: ThreatLevel;
      addedAt: number;
      source?: string;
      description?: string;
    };
  };
}

/**
 * Torrent reputation entry
 */
export interface TorrentReputation {
  /** Torrent info hash */
  infoHash: string;
  /** Reputation score (0-100) */
  score: number;
  /** Reputation status */
  status: ReputationStatus;
  /** Release group name */
  releaseGroup?: string;
  /** Number of seeders */
  seeders?: number;
  /** Number of leechers */
  leechers?: number;
  /** User reports */
  reports: {
    safe: number;
    suspicious: number;
    dangerous: number;
  };
  /** Last verification timestamp */
  lastVerified: number;
  /** Additional notes */
  notes?: string;
}

/**
 * Torrents reputation database
 */
export interface TorrentsReputationDatabase {
  /** Database metadata */
  metadata: {
    version: string;
    lastUpdated: number;
    description: string;
  };
  /** Torrent reputation entries */
  torrents: {
    [infoHash: string]: TorrentReputation;
  };
}

/**
 * Known release group entry
 */
export interface ReleaseGroup {
  /** Group name */
  name: string;
  /** Group aliases */
  aliases: string[];
  /** Trust level (0-100) */
  trustLevel: number;
  /** Whether group is verified */
  verified: boolean;
  /** Group specialization (e.g., 'movies', 'games', 'software') */
  specialization?: string[];
  /** Last activity timestamp */
  lastActive?: number;
  /** Additional notes */
  notes?: string;
}

/**
 * Release groups database
 */
export interface ReleaseGroupsDatabase {
  /** Database metadata */
  metadata: {
    version: string;
    lastUpdated: number;
    description: string;
  };
  /** Release group entries */
  groups: {
    [groupName: string]: ReleaseGroup;
  };
}

/**
 * Scan options
 */
export interface ScanOptions {
  /** Files or directories to scan */
  paths: string[];
  /** Enable deep scan (slower but more thorough) */
  deepScan?: boolean;
  /** Enable heuristic analysis */
  enableHeuristics?: boolean;
  /** Scan timeout in milliseconds */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (progress: ScanProgress) => void;
}

/**
 * Database update result
 */
export interface DatabaseUpdateResult {
  /** Whether update was successful */
  success: boolean;
  /** Updated database types */
  updatedDatabases: ('hashes' | 'torrents' | 'releaseGroups')[];
  /** New version numbers */
  newVersions: {
    hashes?: string;
    torrents?: string;
    releaseGroups?: string;
  };
  /** Error message if update failed */
  error?: string;
  /** Update duration in milliseconds */
  duration: number;
}
