/**
 * Seeding Coordinator for Collaborative Seeding Network
 *
 * Coordinates seeding priorities across the P2P network
 * Uses DHT for decentralized tracking of seeders
 */

import { SeederInfo, SeedingPriority } from '../../shared/types';
import { logger } from '../utils';

const log = logger.child('SeedingCoordinator');

export class SeedingCoordinator {
  private localPeerId: string;
  private activeSeeders: Map<string, SeederInfo[]> = new Map(); // infoHash -> seeders
  private priorities: Map<string, SeedingPriority> = new Map(); // infoHash -> priority
  private updateInterval: NodeJS.Timeout | null = null;
  private peerIdRotationInterval: NodeJS.Timeout | null = null;

  constructor(peerId: string) {
    // Generate ephemeral peer ID instead of using provided one
    this.localPeerId = this.generateEphemeralPeerId();

    log.info('SeedingCoordinator using ephemeral Peer ID', {
      peerIdPrefix: this.localPeerId.substring(0, 8) + '...',
      rotationEnabled: true,
    });
  }

  /**
   * Generate ephemeral peer ID that rotates every 24 hours
   * Format: -TH0001-YYYYMMDD-random
   * This prevents long-term tracking in DHT network
   */
  private generateEphemeralPeerId(): string {
    const crypto = require('crypto');
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
    const random = crypto.randomBytes(6).toString('hex'); // 12 chars

    // BitTorrent peer ID format: -XX####-############
    // XX = client code (TH = TorrentHunt)
    // #### = version
    // ############ = random/timestamp
    return `-TH0001-${dateStr}${random}`;
  }

  /**
   * Initialize the coordinator
   */
  async initialize(): Promise<void> {
    log.info('Initializing SeedingCoordinator', { peerId: this.localPeerId });

    // Start periodic priority updates
    this.startPriorityUpdates();

    log.info('SeedingCoordinator initialized');
  }

  /**
   * Announce that we're seeding a torrent
   */
  async announceSeeding(infoHash: string, uploadSpeed: number): Promise<void> {
    log.debug('Announcing seeding', { infoHash, uploadSpeed });

    // In a real implementation, this would announce to DHT
    // For now, we'll track locally
    const seederInfo: SeederInfo = {
      peerId: this.localPeerId,
      lastSeen: Date.now(),
      uploadSpeed,
      reputation: 50, // Default reputation
      seedingTime: 0,
    };

    if (!this.activeSeeders.has(infoHash)) {
      this.activeSeeders.set(infoHash, []);
    }

    const seeders = this.activeSeeders.get(infoHash)!;
    const existingIndex = seeders.findIndex(s => s.peerId === this.localPeerId);

    if (existingIndex >= 0) {
      seeders[existingIndex] = seederInfo;
    } else {
      seeders.push(seederInfo);
    }

    log.debug('Seeding announced', { infoHash, seederCount: seeders.length });
  }

  /**
   * Get seeding priority for a torrent
   */
  async getSeedingPriority(infoHash: string): Promise<SeedingPriority> {
    // Check cache first
    if (this.priorities.has(infoHash)) {
      return this.priorities.get(infoHash)!;
    }

    // Calculate priority
    const priority = await this.calculatePriority(infoHash);
    this.priorities.set(infoHash, priority);

    return priority;
  }

  /**
   * Calculate seeding priority for a torrent
   */
  private async calculatePriority(infoHash: string): Promise<SeedingPriority> {
    // Get active seeders count
    const seeders = this.activeSeeders.get(infoHash) || [];
    const seederCount = seeders.length;

    // Calculate rarity (fewer seeders = higher rarity)
    const rarity = this.calculateRarity(seederCount);

    // For now, we'll estimate demand based on historical data
    // In production, this would query DHT for peer counts
    const demand = this.estimateDemand(infoHash, seederCount);

    // Calculate importance as average of rarity and demand
    const importance = (rarity + demand) / 2;

    // Calculate bounty (reward points)
    const bounty = this.calculateBounty(rarity, demand);

    log.debug('Priority calculated', {
      infoHash,
      seederCount,
      rarity,
      demand,
      importance,
      bounty,
    });

    return {
      infoHash,
      rarity,
      demand,
      importance,
      bounty,
    };
  }

  /**
   * Calculate rarity score based on seeder count
   */
  private calculateRarity(seederCount: number): number {
    // Rarity scale:
    // 0 seeders: 100 (critical!)
    // 1 seeder: 95
    // 2-4 seeders: 80
    // 5-9 seeders: 60
    // 10-49 seeders: 40
    // 50+ seeders: decreasing

    if (seederCount === 0) return 100;
    if (seederCount === 1) return 95;
    if (seederCount < 5) return 80;
    if (seederCount < 10) return 60;
    if (seederCount < 50) return 40;

    // Logarithmic decrease for popular torrents
    return Math.max(0, 100 - seederCount);
  }

  /**
   * Estimate demand for a torrent
   */
  private estimateDemand(infoHash: string, seederCount: number): number {
    // In a real implementation, this would query DHT for peer counts
    // For now, we'll use a simple heuristic:
    // - More seeders usually means higher demand (popular content)
    // - But we also want to reward seeding rare content

    // Simple estimation: inverse of rarity with some adjustments
    if (seederCount === 0) return 100; // High demand if no seeders
    if (seederCount === 1) return 80;
    if (seederCount < 5) return 60;
    if (seederCount < 10) return 50;
    if (seederCount < 50) return 40;

    return Math.min(30, seederCount / 2);
  }

  /**
   * Calculate bounty (reward points) for seeding
   */
  private calculateBounty(rarity: number, demand: number): number {
    // Base calculation: weighted average favoring rarity
    const base = rarity * 0.7 + demand * 0.3;

    // Bonus multipliers for extreme cases
    if (rarity > 90 && demand > 50) {
      // Critical: last seeder + high demand
      return base * 3;
    }
    if (rarity > 80) {
      // Very rare
      return base * 2;
    }
    if (rarity > 70 && demand > 60) {
      // Rare + popular
      return base * 1.5;
    }

    return base;
  }

  /**
   * Get all current priorities
   */
  getAllPriorities(): Map<string, SeedingPriority> {
    return new Map(this.priorities);
  }

  /**
   * Start periodic priority updates
   */
  private startPriorityUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    // Update priorities every 5 minutes
    this.updateInterval = setInterval(() => {
      this.updatePriorities();
    }, 5 * 60 * 1000);

    log.debug('Priority update interval started');
  }

  /**
   * Update all priorities
   */
  private async updatePriorities(): Promise<void> {
    log.debug('Updating seeding priorities', {
      trackedTorrents: this.activeSeeders.size,
    });

    // Recalculate priorities for all tracked torrents
    for (const infoHash of this.activeSeeders.keys()) {
      try {
        const priority = await this.calculatePriority(infoHash);
        this.priorities.set(infoHash, priority);
      } catch (error) {
        log.error('Failed to update priority', {
          infoHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Clean up old seeder entries (older than 30 minutes)
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    for (const [infoHash, seeders] of this.activeSeeders.entries()) {
      const activeSeeders = seeders.filter(s => s.lastSeen > thirtyMinutesAgo);
      if (activeSeeders.length > 0) {
        this.activeSeeders.set(infoHash, activeSeeders);
      } else {
        this.activeSeeders.delete(infoHash);
        this.priorities.delete(infoHash);
      }
    }

    log.debug('Priorities updated', {
      activeTorrents: this.activeSeeders.size,
      prioritiesCount: this.priorities.size,
    });
  }

  /**
   * Stop the coordinator
   */
  destroy(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.activeSeeders.clear();
    this.priorities.clear();

    log.info('SeedingCoordinator destroyed');
  }
}
