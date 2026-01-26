/**
 * Reputation System for Collaborative Seeding Network
 *
 * Tracks user contribution and rewards seeding activity
 */

import { v4 as uuidv4 } from 'uuid';
import { UserReputation, ReputationTransaction, Badge } from '../../shared/types';
import { logger } from '../utils';
import * as db from '../db/store';

const log = logger.child('ReputationSystem');

export class ReputationSystem {
  private reputation: UserReputation | null = null;
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  /**
   * Initialize reputation system
   */
  async initialize(): Promise<void> {
    log.info('Initializing ReputationSystem', { userId: this.userId });

    this.reputation = await db.getReputation(this.userId);

    if (!this.reputation) {
      // Create new reputation record with starter bonus
      this.reputation = {
        userId: this.userId,
        points: 100, // Starter bonus
        uploadedTotal: 0,
        downloadedTotal: 0,
        ratio: 0,
        rareTorrentsSeeded: 0,
        level: 1,
        badges: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.saveReputation(this.reputation);

      log.info('New reputation record created with starter bonus', {
        userId: this.userId,
        startingPoints: 100,
      });
    } else {
      log.info('Reputation loaded from database', {
        userId: this.userId,
        points: this.reputation.points,
        level: this.reputation.level,
      });
    }
  }

  /**
   * Get current reputation
   */
  getReputation(): UserReputation {
    if (!this.reputation) {
      throw new Error('ReputationSystem not initialized');
    }
    return { ...this.reputation };
  }

  /**
   * Award points for seeding activity
   */
  async awardPoints(params: {
    infoHash: string;
    downloadId: string;
    uploadedBytes: number;
    seedingDuration: number; // seconds
    rarity: number; // 0-100
  }): Promise<{
    pointsEarned: number;
    newTotal: number;
    levelUp: boolean;
    newLevel?: number;
  }> {
    if (!this.reputation) {
      throw new Error('ReputationSystem not initialized');
    }

    log.debug('Awarding points for seeding', params);

    // Base points: 1 point per 100MB uploaded
    let points = params.uploadedBytes / (100 * 1024 * 1024);

    // Multiplier for rarity (rare torrents worth more)
    const rarityMultiplier = 1 + (params.rarity / 100);
    points *= rarityMultiplier;

    // Multiplier for duration (long-term seeding is valuable)
    const hours = params.seedingDuration / 3600;
    let durationMultiplier = 1.0;
    if (hours > 24) durationMultiplier = 1.5;   // +50% for 24+ hours
    if (hours > 168) durationMultiplier = 2.0;  // +100% for 1+ week
    points *= durationMultiplier;

    // Round to 2 decimal places
    points = Math.round(points * 100) / 100;

    // Update reputation
    const oldLevel = this.reputation.level;
    this.reputation.points += points;
    this.reputation.uploadedTotal += params.uploadedBytes;
    this.reputation.ratio = this.reputation.downloadedTotal > 0
      ? this.reputation.uploadedTotal / this.reputation.downloadedTotal
      : this.reputation.uploadedTotal > 0 ? 999 : 0;
    this.reputation.updatedAt = new Date();

    // Track rare torrent seeding
    if (params.rarity > 70) {
      this.reputation.rareTorrentsSeeded++;
    }

    // Check for level up
    const newLevel = this.calculateLevel(this.reputation.points);
    const levelUp = newLevel > oldLevel;
    if (levelUp) {
      this.reputation.level = newLevel;
      log.info('Level up!', {
        userId: this.userId,
        oldLevel,
        newLevel,
        points: this.reputation.points,
      });
    }

    // Record transaction
    const transaction: ReputationTransaction = {
      id: uuidv4(),
      type: 'earn',
      amount: points,
      reason: `Seeded torrent (${this.formatBytes(params.uploadedBytes)}, ${Math.round(hours)}h)`,
      timestamp: Date.now(),
      metadata: {
        infoHash: params.infoHash,
        downloadId: params.downloadId,
      },
    };
    await db.saveReputationTransaction(this.userId, transaction);

    // Check achievements
    await this.checkAchievements();

    // Save updated reputation
    await db.saveReputation(this.reputation);

    log.info('Points awarded', {
      userId: this.userId,
      pointsEarned: points,
      newTotal: this.reputation.points,
      levelUp,
      multipliers: {
        rarity: rarityMultiplier.toFixed(2),
        duration: durationMultiplier.toFixed(2),
      },
    });

    return {
      pointsEarned: points,
      newTotal: this.reputation.points,
      levelUp,
      newLevel: levelUp ? newLevel : undefined,
    };
  }

  /**
   * Update download stats
   */
  async updateDownloadStats(downloadedBytes: number): Promise<void> {
    if (!this.reputation) {
      throw new Error('ReputationSystem not initialized');
    }

    this.reputation.downloadedTotal += downloadedBytes;
    this.reputation.ratio = this.reputation.downloadedTotal > 0
      ? this.reputation.uploadedTotal / this.reputation.downloadedTotal
      : this.reputation.uploadedTotal > 0 ? 999 : 0;
    this.reputation.updatedAt = new Date();

    await db.saveReputation(this.reputation);
  }

  /**
   * Calculate level based on points
   */
  private calculateLevel(points: number): number {
    // Level progression: exponential curve
    // Level 1: 0-100 points
    // Level 2: 100-300 points
    // Level 3: 300-600 points
    // Level 4: 600-1000 points
    // Level 5: 1000-1500 points
    // etc.

    if (points < 100) return 1;
    if (points < 300) return 2;
    if (points < 600) return 3;
    if (points < 1000) return 4;
    if (points < 1500) return 5;
    if (points < 2100) return 6;
    if (points < 2800) return 7;
    if (points < 3600) return 8;
    if (points < 4500) return 9;
    return 10; // Max level
  }

  /**
   * Check and award achievement badges
   */
  private async checkAchievements(): Promise<void> {
    if (!this.reputation) return;

    const newBadges: string[] = [];

    // "Rare Collector" - seeded 10+ rare torrents
    if (this.reputation.rareTorrentsSeeded >= 10 && !this.reputation.badges.includes('RareCollector')) {
      newBadges.push('RareCollector');
    }

    // "Speed Demon" - uploaded 100GB+
    if (this.reputation.uploadedTotal >= 100 * 1024 * 1024 * 1024 && !this.reputation.badges.includes('SpeedDemon')) {
      newBadges.push('SpeedDemon');
    }

    // "Altruist" - ratio > 5.0
    if (this.reputation.ratio > 5.0 && !this.reputation.badges.includes('Altruist')) {
      newBadges.push('Altruist');
    }

    // "Legend" - uploaded 1TB+
    if (this.reputation.uploadedTotal >= 1024 * 1024 * 1024 * 1024 && !this.reputation.badges.includes('Legend')) {
      newBadges.push('Legend');
    }

    // "Dedicated" - reached level 5
    if (this.reputation.level >= 5 && !this.reputation.badges.includes('Dedicated')) {
      newBadges.push('Dedicated');
    }

    // "Master" - reached level 10
    if (this.reputation.level >= 10 && !this.reputation.badges.includes('Master')) {
      newBadges.push('Master');
    }

    // Award new badges
    if (newBadges.length > 0) {
      this.reputation.badges.push(...newBadges);

      for (const badge of newBadges) {
        log.info('Badge earned!', {
          userId: this.userId,
          badge,
        });

        // Award bonus points for earning badge
        const bonusPoints = 50;
        this.reputation.points += bonusPoints;

        const transaction: ReputationTransaction = {
          id: uuidv4(),
          type: 'bonus',
          amount: bonusPoints,
          reason: `Badge earned: ${badge}`,
          timestamp: Date.now(),
          metadata: { badge },
        };
        await db.saveReputationTransaction(this.userId, transaction);
      }
    }
  }

  /**
   * Get available badges with earned status
   */
  getBadges(): Badge[] {
    if (!this.reputation) {
      throw new Error('ReputationSystem not initialized');
    }

    const allBadges: Badge[] = [
      {
        id: 'RareCollector',
        name: 'Rare Collector',
        description: 'Seeded 10+ rare torrents',
        icon: '💎',
        earnedAt: this.reputation.badges.includes('RareCollector') ? new Date() : null,
      },
      {
        id: 'SpeedDemon',
        name: 'Speed Demon',
        description: 'Uploaded 100GB+ total',
        icon: '⚡',
        earnedAt: this.reputation.badges.includes('SpeedDemon') ? new Date() : null,
      },
      {
        id: 'Altruist',
        name: 'Altruist',
        description: 'Upload/Download ratio over 5.0',
        icon: '🤝',
        earnedAt: this.reputation.badges.includes('Altruist') ? new Date() : null,
      },
      {
        id: 'Legend',
        name: 'Legend',
        description: 'Uploaded 1TB+ total',
        icon: '🏆',
        earnedAt: this.reputation.badges.includes('Legend') ? new Date() : null,
      },
      {
        id: 'Dedicated',
        name: 'Dedicated',
        description: 'Reached Level 5',
        icon: '🌟',
        earnedAt: this.reputation.badges.includes('Dedicated') ? new Date() : null,
      },
      {
        id: 'Master',
        name: 'Master',
        description: 'Reached Level 10 (Max)',
        icon: '👑',
        earnedAt: this.reputation.badges.includes('Master') ? new Date() : null,
      },
    ];

    return allBadges;
  }

  /**
   * Helper: format bytes
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
