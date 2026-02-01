/**
 * VirusHunt Component - Simplified & Compact Version
 * Security scanning module for TorrentHunt
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HiShieldCheck,
  HiFolder,
  HiDocumentText,
  HiDownload,
  HiPlay,
  HiStop,
  HiCheckCircle,
  HiExclamation,
  HiXCircle,
  HiCog,
  HiRefresh,
} from 'react-icons/hi';
import { FiAlertTriangle, FiSettings, FiX } from 'react-icons/fi';
import { useVirusHuntStore, categorizeScanResults, getThreatColor, getThreatIcon } from '../stores/virusHuntStore';
import { ScanProgress, ScanResult } from '../../shared/virushunt-types';
import { Button } from './Button';
import { Toggle } from './Toggle';
import './VirusHuntSimple.css';

type ScanMode = 'downloads' | 'folder' | 'file';

const VirusHuntSimple: React.FC = () => {
  const {
    settings,
    updateSettings,
    scanState,
    setScanState,
    resetScanState,
    statistics,
    updateStatistics,
    resetStatistics,
    results,
    addResult,
    clearResults,
    addError,
    addToHistory,
  } = useVirusHuntStore();

  const [selectedMode, setSelectedMode] = useState<ScanMode>('downloads');
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const scanStartTimeRef = useRef<number>(0);

  // Initialize
  useEffect(() => {
    const init = async () => {
      try {
        await window.api.virusHunt.initialize();
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize VirusHunt:', error);
        setInitError(error instanceof Error ? error.message : 'Initialization failed');
      }
    };
    init();
  }, []);

  // Event listeners
  useEffect(() => {
    const unsubProgress = window.api.virusHunt.onScanProgress((progress: ScanProgress) => {
      setScanState({
        progress: progress.progress,
        currentFile: progress.currentFile,
        filesScanned: progress.scannedFiles,
        filesTotal: progress.totalFiles,
      });
    });

    const unsubComplete = window.api.virusHunt.onScanComplete((data: { scanId: string; result: ScanResult }) => {
      const scanTime = (Date.now() - scanStartTimeRef.current) / 1000;
      const stats = categorizeScanResults(data.result.fileResults as any);
      stats.scanTime = scanTime;

      updateStatistics(stats);
      setScanState({ isScanning: false, progress: 100, results: data.result.fileResults as any });

      addToHistory({ id: data.scanId, mode: selectedMode, statistics: stats });

      data.result.fileResults.forEach((scanResult) => {
        addResult({
          path: scanResult.filePath,
          category: scanResult.threats.length > 0 ? 'dangerous' as any : 'safe' as any,
          riskScore: scanResult.threats.reduce((sum, t) => sum + t.confidence, 0) / (scanResult.threats.length || 1),
          threats: scanResult.threats.map(t => t.description) as any,
          isWhitelisted: false,
          scanDate: new Date(),
        });
      });
    });

    const unsubError = window.api.virusHunt.onScanError((data: { scanId: string; error: string }) => {
      setScanState({ isScanning: false });
      addError({ code: 'SCAN_ERROR', message: data.error });
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMode]);

  // Mode selection
  const handleModeSelect = async (mode: ScanMode) => {
    setSelectedMode(mode);
    setSelectedPath('');

    if (mode === 'folder') {
      const result = await window.api.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Выберите папку',
      });
      if (!result.canceled && result.filePaths.length > 0) {
        setSelectedPath(result.filePaths[0]);
      }
    } else if (mode === 'file') {
      const result = await window.api.dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Выберите файл',
        filters: [
          { name: 'Executables', extensions: ['exe', 'dll', 'msi'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        setSelectedPath(result.filePaths[0]);
      }
    }
  };

  // Start scan
  const handleStartScan = useCallback(async () => {
    if (scanState.isScanning) return;
    if (selectedMode !== 'downloads' && !selectedPath) {
      addError({ code: 'NO_PATH', message: 'Выберите файл или папку' });
      return;
    }

    try {
      resetScanState();
      resetStatistics();
      clearResults();
      setScanState({ isScanning: true, progress: 0, currentFile: '', filesScanned: 0, filesTotal: 0 });
      scanStartTimeRef.current = Date.now();

      let paths: string[] = [];
      if (selectedMode === 'downloads') {
        const appSettings = await window.api.getSettings();
        paths = [appSettings.defaultDownloadDir || ''];
      } else {
        paths = [selectedPath];
      }

      if (!paths[0]) throw new Error('Путь не выбран');

      const result = await window.api.virusHunt.startScan({
        paths,
        deepScan: settings.deepScan,
        enableHeuristics: true,
        timeout: 30000,
      });
      setScanState({ scanId: result.scanId });
    } catch (error) {
      setScanState({ isScanning: false });
      addError({ code: 'START_SCAN_ERROR', message: error instanceof Error ? error.message : 'Ошибка' });
    }
  }, [selectedMode, selectedPath, settings, scanState.isScanning, setScanState, resetScanState, resetStatistics, clearResults, addError]);

  // Cancel scan
  const handleCancelScan = async () => {
    if (scanState.scanId) {
      await window.api.virusHunt.cancelScan(scanState.scanId);
      setScanState({ isScanning: false });
    }
  };

  // Format helpers
  const formatTime = (sec: number) => sec < 60 ? `${sec.toFixed(1)}с` : `${Math.floor(sec / 60)}м ${Math.floor(sec % 60)}с`;
  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  if (!isInitialized) {
    return (
      <div className="vh-container">
        <div className="vh-loading">
          <HiShieldCheck className="vh-loading-icon" />
          {initError ? (
            <p className="vh-error">{initError}</p>
          ) : (
            <p>Инициализация...</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="vh-container">
      {/* Header */}
      <div className="vh-header">
        <div className="vh-title">
          <HiShieldCheck />
          <span>VirusHunt</span>
        </div>
        <button className="vh-settings-btn" onClick={() => setShowSettings(!showSettings)}>
          <FiSettings />
        </button>
      </div>

      {/* Quick Settings */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            className="vh-quick-settings"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="vh-setting-row">
              <span>Глубокое сканирование</span>
              <Toggle
                checked={settings.deepScan}
                onChange={(v) => updateSettings({ deepScan: v })}
                disabled={scanState.isScanning}
              />
            </div>
            <div className="vh-setting-row">
              <span>Авто-проверка загрузок</span>
              <Toggle
                checked={settings.autoCheck}
                onChange={(v) => updateSettings({ autoCheck: v })}
                disabled={scanState.isScanning}
              />
            </div>
            <div className="vh-setting-row">
              <span>Чувствительность: {settings.sensitivity}%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={settings.sensitivity}
                onChange={(e) => updateSettings({ sensitivity: parseInt(e.target.value) })}
                disabled={scanState.isScanning}
                className="vh-slider"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Scan Modes */}
      <div className="vh-modes">
        <button
          className={`vh-mode ${selectedMode === 'downloads' ? 'active' : ''}`}
          onClick={() => handleModeSelect('downloads')}
          disabled={scanState.isScanning}
        >
          <HiDownload />
          <span>Загрузки</span>
        </button>
        <button
          className={`vh-mode ${selectedMode === 'folder' ? 'active' : ''}`}
          onClick={() => handleModeSelect('folder')}
          disabled={scanState.isScanning}
        >
          <HiFolder />
          <span>Папка</span>
        </button>
        <button
          className={`vh-mode ${selectedMode === 'file' ? 'active' : ''}`}
          onClick={() => handleModeSelect('file')}
          disabled={scanState.isScanning}
        >
          <HiDocumentText />
          <span>Файл</span>
        </button>
      </div>

      {/* Selected Path */}
      {selectedPath && (
        <div className="vh-selected-path">
          <span title={selectedPath}>{selectedPath.split(/[/\\]/).slice(-2).join('/')}</span>
          <button onClick={() => setSelectedPath('')}><FiX /></button>
        </div>
      )}

      {/* Action Button */}
      <div className="vh-action">
        {!scanState.isScanning ? (
          <Button
            variant="primary"
            size="lg"
            icon={<HiPlay />}
            onClick={handleStartScan}
            disabled={selectedMode !== 'downloads' && !selectedPath}
            className="vh-scan-btn"
          >
            Сканировать
          </Button>
        ) : (
          <div className="vh-scanning">
            <div className="vh-progress">
              <div className="vh-progress-bar" style={{ width: `${scanState.progress}%` }} />
            </div>
            <div className="vh-progress-info">
              <span>{scanState.filesScanned}/{scanState.filesTotal}</span>
              <span>{scanState.progress.toFixed(0)}%</span>
            </div>
            {scanState.currentFile && (
              <div className="vh-current-file" title={scanState.currentFile}>
                {scanState.currentFile.split(/[/\\]/).pop()}
              </div>
            )}
            <Button variant="danger" size="sm" icon={<HiStop />} onClick={handleCancelScan}>
              Отмена
            </Button>
          </div>
        )}
      </div>

      {/* Stats */}
      {(statistics.totalFiles > 0 || scanState.isScanning) && (
        <div className="vh-stats">
          <div className="vh-stat safe">
            <HiCheckCircle />
            <span>{statistics.safeFiles}</span>
            <small>Безопасно</small>
          </div>
          <div className="vh-stat warning">
            <HiExclamation />
            <span>{statistics.suspiciousFiles}</span>
            <small>Подозрит.</small>
          </div>
          <div className="vh-stat danger">
            <HiXCircle />
            <span>{statistics.dangerousFiles + statistics.threatsFound}</span>
            <small>Угрозы</small>
          </div>
          {!scanState.isScanning && statistics.scanTime > 0 && (
            <div className="vh-stat info">
              <HiRefresh />
              <span>{formatTime(statistics.scanTime)}</span>
              <small>Время</small>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {!scanState.isScanning && results.length > 0 && (
        <div className="vh-results">
          <div className="vh-results-header">
            <span>Результаты ({results.length})</span>
            <button onClick={clearResults}>Очистить</button>
          </div>
          <div className="vh-results-list">
            {results.slice(0, 50).map((r, i) => (
              <div key={i} className={`vh-result vh-result-${r.category}`}>
                <div className="vh-result-icon" style={{ color: getThreatColor(r.category) }}>
                  {getThreatIcon(r.category)}
                </div>
                <div className="vh-result-info">
                  <div className="vh-result-name" title={r.path}>
                    {r.path.split(/[/\\]/).pop()}
                  </div>
                  {r.threats.length > 0 && (
                    <div className="vh-result-threats">{r.threats.slice(0, 2).join(', ')}</div>
                  )}
                </div>
                <div className="vh-result-score">{Math.round(r.riskScore)}</div>
              </div>
            ))}
            {results.length > 50 && (
              <div className="vh-results-more">+{results.length - 50} ещё</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VirusHuntSimple;
