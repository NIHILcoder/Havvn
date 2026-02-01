/**
 * VirusHunt Page - Simplified Version
 * Compact security scanner with integrated settings and Deep Analysis
 */

import React, { useState, lazy, Suspense } from 'react';
import VirusHuntSimple from '../components/VirusHuntSimple';
import SecuritySettingsSimple from '../components/SecuritySettingsSimple';
import { FiSettings, FiX, FiShield, FiCpu } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import './VirusHuntPage.css';

const DeepAnalysisPage = lazy(() => import('./DeepAnalysisPage'));

type TabId = 'quick-scan' | 'deep-analysis';

const VirusHuntPage: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('quick-scan');

  return (
    <div className="vhp-container">
      {/* Tabs */}
      <div className="vhp-tabs">
        <button
          className={`vhp-tab ${activeTab === 'quick-scan' ? 'active' : ''}`}
          onClick={() => setActiveTab('quick-scan')}
        >
          <FiShield />
          <span>Quick Scan</span>
        </button>
        <button
          className={`vhp-tab ${activeTab === 'deep-analysis' ? 'active' : ''}`}
          onClick={() => setActiveTab('deep-analysis')}
        >
          <FiCpu />
          <span>Deep Analysis</span>
        </button>
      </div>

      {/* Main Content */}
      <div className="vhp-main">
        {activeTab === 'quick-scan' ? (
          <VirusHuntSimple />
        ) : (
          <Suspense fallback={<div className="vhp-loading">Loading Deep Analysis...</div>}>
            <DeepAnalysisPage />
          </Suspense>
        )}
        
        {/* Settings Button - Fixed */}
        <button 
          className="vhp-settings-fab"
          onClick={() => setShowSettings(true)}
          title="Настройки безопасности"
        >
          <FiSettings />
        </button>
      </div>

      {/* Settings Sidebar */}
      <AnimatePresence mode="wait">
        {showSettings && (
          <React.Fragment key="settings-panel">
            <motion.div
              key="overlay"
              className="vhp-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setShowSettings(false)}
            />
            <motion.div
              key="sidebar"
              className="vhp-sidebar"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <button 
                className="vhp-sidebar-close"
                onClick={() => setShowSettings(false)}
              >
                <FiX />
              </button>
              <SecuritySettingsSimple onClose={() => setShowSettings(false)} />
            </motion.div>
          </React.Fragment>
        )}
      </AnimatePresence>
    </div>
  );
};

export default VirusHuntPage;
