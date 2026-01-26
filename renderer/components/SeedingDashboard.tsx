/**
 * Seeding Dashboard Component
 *
 * Shows user reputation, recommendations, and badges for Collaborative Seeding Network
 */

import React, { useState, useEffect } from 'react';
import { Icon, ProgressBar } from '../components';
import { UserReputation, SeedingPlan, ReputationTransaction, Badge } from '../../shared/types';
import './SeedingDashboard.css';

export const SeedingDashboard: React.FC = () => {
  const [reputation, setReputation] = useState<UserReputation | null>(null);
  const [recommendations, setRecommendations] = useState<SeedingPlan | null>(null);
  const [transactions, setTransactions] = useState<ReputationTransaction[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [rep, recs, txs, bdgs] = await Promise.all([
        window.api.getReputation(),
        window.api.getSeedingRecommendations(5),
        window.api.getRecentTransactions(10),
        window.api.getBadges(),
      ]);

      setReputation(rep);
      setRecommendations(recs);
      setTransactions(txs);
      setBadges(bdgs);
    } catch (error) {
      console.error('Failed to load seeding data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    try {
      await window.api.enableCollaborativeSeeding(!enabled);
      setEnabled(!enabled);
    } catch (error) {
      console.error('Failed to toggle collaborative seeding:', error);
    }
  };

  const getLevelProgress = () => {
    if (!reputation) return 0;

    // Level thresholds
    const thresholds = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500];
    const currentLevel = reputation.level;

    if (currentLevel >= 10) return 100; // Max level

    const currentThreshold = thresholds[currentLevel - 1];
    const nextThreshold = thresholds[currentLevel];

    const progress = ((reputation.points - currentThreshold) / (nextThreshold - currentThreshold)) * 100;
    return Math.min(100, Math.max(0, progress));
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatTimeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'только что';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
    return `${Math.floor(seconds / 86400)} дн назад`;
  };

  if (loading) {
    return (
      <div className="seeding-dashboard loading">
        <Icon name="loader" size={32} className="spinner" />
        <p>Загрузка данных...</p>
      </div>
    );
  }

  return (
    <div className="seeding-dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <h1>🌐 Collaborative Seeding Network</h1>
        <p className="dashboard-subtitle">
          Зарабатывайте баллы за раздачу редких торрентов и помогайте сообществу
        </p>

        <div className="enable-toggle">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleToggleEnabled}
            />
            <span>Включить Collaborative Seeding</span>
          </label>
        </div>
      </div>

      {/* Reputation Card */}
      <div className="reputation-card">
        <div className="reputation-header">
          <h2>Ваша репутация</h2>
          <div className="level-badge">
            <span className="level-number">{reputation?.level || 1}</span>
            <span className="level-label">уровень</span>
          </div>
        </div>

        <div className="reputation-stats">
          <div className="stat-item">
            <div className="stat-value">{reputation?.points.toFixed(0) || 0}</div>
            <div className="stat-label">Баллов</div>
          </div>

          <div className="stat-item">
            <div className="stat-value">{reputation?.ratio.toFixed(2) || '0.00'}</div>
            <div className="stat-label">Ratio</div>
          </div>

          <div className="stat-item">
            <div className="stat-value">{formatBytes(reputation?.uploadedTotal || 0)}</div>
            <div className="stat-label">Отдано</div>
          </div>

          <div className="stat-item">
            <div className="stat-value">{reputation?.rareTorrentsSeeded || 0}</div>
            <div className="stat-label">Редких торрентов</div>
          </div>
        </div>

        {/* Level progress */}
        <div className="level-progress">
          <div className="progress-header">
            <span>Прогресс до уровня {(reputation?.level || 1) + 1}</span>
            <span>{getLevelProgress().toFixed(0)}%</span>
          </div>
          <ProgressBar value={getLevelProgress()} />
        </div>

        {/* Badges */}
        <div className="badges-section">
          <h3>Достижения</h3>
          <div className="badges-grid">
            {badges.map(badge => (
              <div
                key={badge.id}
                className={`badge-item ${badge.earnedAt ? 'earned' : 'locked'}`}
                title={badge.description}
              >
                <div className="badge-icon">{badge.icon}</div>
                <div className="badge-name">{badge.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Seeding Recommendations */}
      <div className="recommendations-section">
        <h2>💡 Рекомендуемое для раздачи</h2>
        <p className="section-subtitle">
          Эти торренты принесут вам больше всего баллов
        </p>

        {recommendations && recommendations.torrents.length > 0 ? (
          <div className="recommendations-list">
            {recommendations.torrents.map(rec => (
              <div key={rec.downloadId} className="recommendation-card">
                <div className="rec-header">
                  <div className="rec-name">{rec.torrentName}</div>
                  <div className="rec-bounty">
                    <Icon name="star" size={16} />
                    <span>+{rec.expectedBounty.toFixed(0)} баллов</span>
                  </div>
                </div>

                <div className="rec-reason">{rec.reason}</div>

                <div className="rec-stats">
                  <div className="rec-stat">
                    <span className="stat-label">Редкость:</span>
                    <span className="stat-value">{rec.priority.rarity.toFixed(0)}/100</span>
                  </div>
                  <div className="rec-stat">
                    <span className="stat-label">Спрос:</span>
                    <span className="stat-value">{rec.priority.demand.toFixed(0)}/100</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-recommendations">
            <Icon name="inbox" size={48} />
            <p>Завершите загрузку торрентов, чтобы получить рекомендации</p>
          </div>
        )}
      </div>

      {/* Recent Transactions */}
      <div className="transactions-section">
        <h2>📜 Последние транзакции</h2>

        {transactions.length > 0 ? (
          <div className="transactions-list">
            {transactions.map(tx => (
              <div key={tx.id} className="transaction-item">
                <div className={`tx-amount ${tx.amount > 0 ? 'positive' : 'negative'}`}>
                  {tx.amount > 0 ? '+' : ''}{tx.amount.toFixed(2)}
                </div>
                <div className="tx-details">
                  <div className="tx-reason">{tx.reason}</div>
                  <div className="tx-time">{formatTimeAgo(tx.timestamp)}</div>
                </div>
                <div className="tx-type">
                  {tx.type === 'earn' && <span className="tx-badge tx-badge-earn">Заработано</span>}
                  {tx.type === 'bonus' && <span className="tx-badge tx-badge-bonus">Бонус</span>}
                  {tx.type === 'spend' && <span className="tx-badge tx-badge-spend">Потрачено</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-transactions">
            <Icon name="activity" size={48} />
            <p>История транзакций пуста</p>
          </div>
        )}
      </div>
    </div>
  );
};
