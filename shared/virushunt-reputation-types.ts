/**
 * VirusHunt Reputation System Types
 * 
 * Extended types for reputation database and malicious pattern detection.
 */

// ============================================================================
// Reputation Database Types
// ============================================================================

export interface WhitelistEntry {
  hash: string;
  name: string;
  size: number;
  verified_by: 'user' | 'community' | 'antivirus' | 'signature';
  last_check: string; // ISO date
  source?: string;
  added_at: string; // ISO date
  notes?: string;
}

export interface BlacklistEntry {
  hash: string;
  name: string;
  size?: number;
  threat_type: 'malware' | 'trojan' | 'miner' | 'ransomware' | 'keylogger' | 'backdoor' | 'adware' | 'pup';
  severity: 'low' | 'medium' | 'high' | 'critical';
  verified_by: 'user' | 'community' | 'antivirus' | 'behavioral';
  last_check: string; // ISO date
  source?: string;
  added_at: string; // ISO date
  description?: string;
  detection_count?: number; // How many AVs detected it
}

export interface HashesDatabase {
  version: string;
  last_updated: string; // ISO date
  whitelist: Record<string, WhitelistEntry>;
  blacklist: Record<string, BlacklistEntry>;
}

// ============================================================================
// Torrent Reputation Types
// ============================================================================

export interface TorrentReputation {
  infohash: string;
  name?: string;
  clean_reports: number;
  malware_reports: number;
  suspicious_reports: number;
  last_updated: string; // ISO date
  files_checked: number;
  total_files: number;
  release_group?: string;
  uploader?: string;
  trust_score: number; // 0-100
  verified: boolean;
}

export interface TorrentsReputationDatabase {
  version: string;
  last_updated: string;
  torrents: Record<string, TorrentReputation>;
}

// ============================================================================
// Release Group Types
// ============================================================================

export interface ReleaseGroup {
  name: string;
  trust_level: 'trusted' | 'verified' | 'neutral' | 'suspicious' | 'blacklisted';
  patterns: string[]; // Regex patterns to match group tags
  verified: boolean;
  clean_releases: number;
  malicious_releases: number;
  added_at: string;
  last_seen: string;
  notes?: string;
  aliases?: string[];
}

export interface ReleaseGroupsDatabase {
  version: string;
  last_updated: string;
  groups: ReleaseGroup[];
}

// ============================================================================
// Malicious Patterns Types
// ============================================================================

export interface MaliciousPattern {
  type: 'url' | 'api' | 'domain' | 'string' | 'registry' | 'file';
  pattern: string; // Regex or exact match
  category: 'mining' | 'c2' | 'phishing' | 'download' | 'keylogger' | 'backdoor';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  is_regex: boolean;
}

export interface MaliciousPatternsDatabase {
  version: string;
  last_updated: string;
  mining_pools: MaliciousPattern[];
  c2_domains: MaliciousPattern[];
  suspicious_apis: MaliciousPattern[];
  malware_strings: MaliciousPattern[];
  registry_keys: MaliciousPattern[];
}

// ============================================================================
// Reputation Check Results
// ============================================================================

export interface ReputationResult {
  status: 'whitelisted' | 'blacklisted' | 'unknown';
  entry?: WhitelistEntry | BlacklistEntry;
  confidence: number; // 0-100
  source: string;
}

export interface TorrentReputationResult {
  status: 'trusted' | 'suspicious' | 'dangerous' | 'unknown';
  reputation?: TorrentReputation;
  trust_score: number; // 0-100
  details: string;
}

export interface PatternMatchResult {
  matched: boolean;
  patterns: MaliciousPattern[];
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string[];
}

// ============================================================================
// Database Statistics
// ============================================================================

export interface DatabaseStats {
  hashes: {
    whitelist_count: number;
    blacklist_count: number;
    version: string;
    last_updated: string;
  };
  torrents: {
    total_count: number;
    trusted_count: number;
    suspicious_count: number;
    dangerous_count: number;
    version: string;
    last_updated: string;
  };
  release_groups: {
    total_count: number;
    trusted_count: number;
    verified_count: number;
    blacklisted_count: number;
    version: string;
    last_updated: string;
  };
  patterns: {
    total_count: number;
    mining_count: number;
    c2_count: number;
    api_count: number;
    version: string;
    last_updated: string;
  };
}

// ============================================================================
// Import/Export Types
// ============================================================================

export interface DatabaseExportOptions {
  type: 'hashes' | 'torrents' | 'release-groups' | 'patterns' | 'all';
  format: 'json' | 'csv';
  include_metadata: boolean;
}

export interface DatabaseImportResult {
  success: boolean;
  imported_count: number;
  skipped_count: number;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// Configuration
// ============================================================================

export interface ReputationConfig {
  auto_update: boolean;
  check_on_scan: boolean;
  trust_community: boolean;
  min_confidence: number; // 0-100
  cache_ttl: number; // seconds
  use_release_groups: boolean;
  use_pattern_matching: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

export type ReputationSource = 'local' | 'community' | 'antivirus' | 'user';
export type ThreatLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ReputationUpdate {
  hash?: string;
  infohash?: string;
  action: 'add_whitelist' | 'add_blacklist' | 'remove' | 'update_torrent' | 'verify';
  data: Partial<WhitelistEntry | BlacklistEntry | TorrentReputation>;
  timestamp: string;
  source: ReputationSource;
}
