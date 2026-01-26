/**
 * Seeding Optimizer for Collaborative Seeding Network
 *
 * Optimizes which torrents to seed based on priorities and user bandwidth
 */

import { Download, SeedingPlan, SeedingRecommendation } from '../../shared/types';
import { SeedingCoordinator } from './coordinator';
import { logger } from '../utils';

const log = logger.child('SeedingOptimizer');

export class SeedingOptimizer {
  private coordinator: SeedingCoordinator;

  constructor(coordinator: SeedingCoordinator) {
    this.coordinator = coordinator;
  }

  /**
   * Generate optimal seeding plan
   */
  async optimizeSeedingStrategy(params: {
    userTorrents: Download[];
    maxSeedingSlots: number;
    userBandwidthKbps: number;
  }): Promise<SeedingPlan> {
    log.info('Optimizing seeding strategy', {
      torrentCount: params.userTorrents.length,
      maxSlots: params.maxSeedingSlots,
      bandwidthKbps: params.userBandwidthKbps,
    });

    const recommendations: SeedingRecommendation[] = [];

    // 1. Filter completed/seeding torrents
    const eligibleTorrents = params.userTorrents.filter(
      t => t.status === 'completed' || t.status === 'seeding'
    );

    if (eligibleTorrents.length === 0) {
      log.debug('No eligible torrents for seeding');
      return {
        torrents: [],
        totalExpectedBounty: 0,
      };
    }

    // 2. Get priorities for each torrent
    const torrentPriorities = await Promise.all(
      eligibleTorrents.map(async (torrent) => {
        try {
          // Extract infoHash from torrent (we'll need to get this from torrent manager)
          // For now, use sourceUri as a proxy
          const infoHash = this.extractInfoHash(torrent);
          const priority = await this.coordinator.getSeedingPriority(infoHash);

          return {
            torrent,
            priority,
            infoHash,
          };
        } catch (error) {
          log.error('Failed to get priority for torrent', {
            id: torrent.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })
    );

    // Filter out nulls
    const validPriorities = torrentPriorities.filter(p => p !== null) as Array<{
      torrent: Download;
      priority: any;
      infoHash: string;
    }>;

    // 3. Sort by importance/bounty (prioritize rare + high-demand torrents)
    validPriorities.sort((a, b) => {
      // Primary: bounty (reward)
      const bountyDiff = b.priority.bounty - a.priority.bounty;
      if (Math.abs(bountyDiff) > 5) return bountyDiff;

      // Secondary: importance
      const importanceDiff = b.priority.importance - a.priority.importance;
      if (Math.abs(importanceDiff) > 5) return importanceDiff;

      // Tertiary: already uploaded bytes (reward continued seeding)
      return b.torrent.uploadedBytes - a.torrent.uploadedBytes;
    });

    // 4. Select top N torrents
    const selectedTorrents = validPriorities.slice(0, params.maxSeedingSlots);

    // 5. Allocate bandwidth
    const bandwidthAllocations = this.allocateBandwidth(
      selectedTorrents.length,
      params.userBandwidthKbps
    );

    // 6. Create recommendations
    for (let i = 0; i < selectedTorrents.length; i++) {
      const item = selectedTorrents[i];
      const allocatedBandwidth = bandwidthAllocations[i];

      recommendations.push({
        downloadId: item.torrent.id,
        torrentName: item.torrent.name,
        allocatedBandwidth,
        expectedBounty: item.priority.bounty,
        reason: this.getRecommendationReason(item.priority),
        priority: item.priority,
      });
    }

    const totalExpectedBounty = recommendations.reduce(
      (sum, r) => sum + r.expectedBounty,
      0
    );

    log.info('Seeding plan generated', {
      selectedCount: recommendations.length,
      totalExpectedBounty: totalExpectedBounty.toFixed(2),
    });

    return {
      torrents: recommendations,
      totalExpectedBounty,
    };
  }

  /**
   * Allocate bandwidth among torrents
   */
  private allocateBandwidth(torrentCount: number, totalBandwidthKbps: number): number[] {
    if (torrentCount === 0) return [];

    const allocations: number[] = [];

    // Simple equal distribution for now
    // In the future, could prioritize based on priority scores
    const perTorrent = Math.floor(totalBandwidthKbps / torrentCount);

    for (let i = 0; i < torrentCount; i++) {
      allocations.push(perTorrent);
    }

    return allocations;
  }

  /**
   * Get human-readable reason for recommendation
   */
  private getRecommendationReason(priority: any): string {
    if (priority.rarity > 90) {
      return '🔥 Критический торрент! Последний сид';
    }
    if (priority.demand > 80) {
      return '⚡ Высокий спрос! Много желающих скачать';
    }
    if (priority.rarity > 70) {
      return '💎 Редкий торрент, нужна помощь';
    }
    if (priority.bounty > 50) {
      return '💰 Высокая награда за раздачу';
    }
    return '✅ Хороший выбор для раздачи';
  }

  /**
   * Extract infoHash from download (temporary implementation)
   */
  private extractInfoHash(download: Download): string {
    // Try to extract from magnet URI
    if (download.sourceType === 'magnet') {
      const match = download.sourceUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    // Fallback: use download ID as pseudo-hash
    return download.id;
  }
}
