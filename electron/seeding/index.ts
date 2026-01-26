/**
 * Collaborative Seeding Manager
 *
 * Main orchestrator for the Collaborative Seeding Network
 */

import { v4 as uuidv4 } from 'uuid';
import { UserReputation, SeedingPlan, ReputationTransaction, Badge } from '../../shared/types';
import { ReputationSystem } from './reputation';
import { SeedingCoordinator } from './coordinator';
import { SeedingOptimizer } from './optimizer';
import { logger } from '../utils';
import { getTorrentManager } from '../torrent/manager';

const log = logger.child('CollaborativeSeeding');

export class CollaborativeSeedingManager {
  private enabled: boolean = false;
  private reputationSystem: ReputationSystem;
  private coordinator: SeedingCoordinator;
  private optimizer: SeedingOptimizer;
  private userId: string;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Generate or load user ID
    this.userId = this.getOrCreateUserId();

    // Initialize subsystems
    this.reputationSystem = new ReputationSystem(this.userId);
    this.coordinator = new SeedingCoordinator(this.userId);
    this.optimizer = new SeedingOptimizer(this.coordinator);
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    log.info('Initializing CollaborativeSeedingManager');

    await this.reputationSystem.initialize();
    await this.coordinator.initialize();

    // Start monitoring if enabled
    if (this.enabled) {
      this.startMonitoring();
    }

    log.info('CollaborativeSeedingManager initialized', {
      enabled: this.enabled,
      userId: this.userId,
    });
  }

  /**
   * Enable/disable collaborative seeding
   */
  async setEnabled(enabled: boolean): Promise<void> {
    log.info('Collaborative seeding enabled changed', { enabled });

    this.enabled = enabled;

    if (enabled) {
      this.startMonitoring();
    } else {
      this.stopMonitoring();
    }
  }

  /**
   * Get user reputation
   */
  getReputation(): UserReputation {
    return this.reputationSystem.getReputation();
  }

  /**
   * Get seeding recommendations
   */
  async getSeedingRecommendations(maxSlots: number = 5): Promise<SeedingPlan> {
    const torrentManager = getTorrentManager();
    const downloads = await torrentManager.getDownloads();

    // Get user bandwidth settings (from settings)
    const settings = await import('../db/store').then(db => db.getSettings());
    const userBandwidthKbps = settings.maxUpKbps || 1000; // Default 1 MB/s

    return this.optimizer.optimizeSeedingStrategy({
      userTorrents: downloads,
      maxSeedingSlots: maxSlots,
      userBandwidthKbps,
    });
  }

  /**
   * Get all seeding priorities
   */
  getSeedingPriorities() {
    return this.coordinator.getAllPriorities();
  }

  /**
   * Get recent reputation transactions
   */
  async getRecentTransactions(limit: number = 20): Promise<ReputationTransaction[]> {
    const db = await import('../db/store');
    return db.getReputationTransactions(this.userId, limit);
  }

  /**
   * Get available badges
   */
  getBadges(): Badge[] {
    return this.reputationSystem.getBadges();
  }

  /**
   * Start monitoring seeding activity
   */
  private startMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    log.info('Starting seeding activity monitoring');

    // Monitor every 5 minutes
    this.monitorInterval = setInterval(() => {
      this.monitorSeedingActivity();
    }, 5 * 60 * 1000);

    // Run immediately
    this.monitorSeedingActivity();
  }

  /**
   * Stop monitoring
   */
  private stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      log.info('Seeding activity monitoring stopped');
    }
  }

  /**
   * Monitor seeding activity and award points
   */
  private async monitorSeedingActivity(): Promise<void> {
    try {
      const torrentManager = getTorrentManager();
      const downloads = await torrentManager.getDownloads();

      // Find seeding torrents
      const seedingTorrents = downloads.filter(d => d.status === 'seeding');

      log.debug('Monitoring seeding activity', {
        seedingCount: seedingTorrents.length,
      });

      for (const torrent of seedingTorrents) {
        try {
          // Get infoHash
          const infoHash = this.extractInfoHash(torrent);

          // Announce seeding
          await this.coordinator.announceSeeding(infoHash, torrent.upSpeedBps);

          // Award points if significant upload has occurred
          // Check if this torrent has earned points recently (simple: check upload delta)
          const uploadedSinceStart = torrent.uploadedBytes;

          if (uploadedSinceStart > 10 * 1024 * 1024) { // At least 10MB uploaded
            // Get priority to calculate bounty
            const priority = await this.coordinator.getSeedingPriority(infoHash);

            // Estimate seeding duration (simplified - would need to track start time in production)
            const seedingDuration = 5 * 60; // 5 minutes (our monitoring interval)

            // Award points
            const result = await this.reputationSystem.awardPoints({
              infoHash,
              downloadId: torrent.id,
              uploadedBytes: uploadedSinceStart,
              seedingDuration,
              rarity: priority.rarity,
            });

            if (result.levelUp) {
              log.info('User leveled up!', {
                newLevel: result.newLevel,
                points: result.newTotal,
              });
            }
          }
        } catch (error) {
          log.error('Failed to process seeding torrent', {
            id: torrent.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      log.error('Failed to monitor seeding activity', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Extract infoHash from download
   */
  private extractInfoHash(download: any): string {
    if (download.sourceType === 'magnet') {
      const match = download.sourceUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }
    return download.id;
  }

  /**
   * Get or create anonymous user ID with daily rotation
   * This ensures privacy by preventing long-term tracking
   */
  private getOrCreateUserId(): string {
    const crypto = require('crypto');
    const os = require('os');

    // Create a seed from machine-specific but not personally identifiable data
    // Changes daily to prevent long-term tracking
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const machineId = os.hostname(); // Local hostname (not sent anywhere)

    // Generate deterministic but anonymous ID that rotates daily
    const seed = `${machineId}-${today}-torrenthunt-anon`;
    const hash = crypto.createHash('sha256').update(seed).digest('hex');

    // Use first 16 characters as anonymous ID
    const anonymousId = `anon-${hash.substring(0, 16)}`;

    log.info('Generated ephemeral anonymous user ID', {
      idHash: anonymousId.substring(0, 12) + '...', // Only log partial ID
      rotatesDaily: true,
    });

    return anonymousId;
  }

  /**
   * Destroy the manager
   */
  destroy(): void {
    this.stopMonitoring();
    this.coordinator.destroy();
    log.info('CollaborativeSeedingManager destroyed');
  }
}

// Singleton instance
let collaborativeSeedingManager: CollaborativeSeedingManager | null = null;

export function getCollaborativeSeedingManager(): CollaborativeSeedingManager {
  if (!collaborativeSeedingManager) {
    collaborativeSeedingManager = new CollaborativeSeedingManager();
  }
  return collaborativeSeedingManager;
}
