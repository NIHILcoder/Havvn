/**
 * VirusHunt Page - Simplified Version
 * Compact security scanner with integrated settings
 */

import React, { useState } from 'react';
import VirusHuntSimple from '../components/VirusHuntSimple';
import SecuritySettingsSimple from '../components/SecuritySettingsSimple';
import { FiShield, FiSettings, FiX } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import './VirusHuntPage.css';

const VirusHuntPage: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="vhp-container">
      {/* Main Content */}
      <div className="vhp-main">
        <VirusHuntSimple />
        
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
      <AnimatePresence>
        {showSettings && (
          <>
            <motion.div
              className="vhp-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
            />
            <motion.div
              className="vhp-sidebar"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
              <button 
                className="vhp-sidebar-close"
                onClick={() => setShowSettings(false)}
              >
                <FiX />
              </button>
              <SecuritySettingsSimple onClose={() => setShowSettings(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default VirusHuntPage;
