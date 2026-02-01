/**
 * VirusHunt Component
 * 
 * Security scanning module for TorrentHunt with advanced heuristic analysis
 */

import React, { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog, Transition } from '@headlessui/react';
import {
  HiShieldCheck,
  HiFolder,
  HiDocumentText,
  HiDownload,
  HiCog,
  HiPlay,
  HiStop,
  HiExclamation,
  HiCheckCircle,
  HiXCircle,
  HiX,
} from 'react-icons/hi';
import { FiAlertTriangle, FiLock, FiKey } from 'react-icons/fi';
import { useVirusHuntStore, categorizeScanResults, getThreatColor, getThreatIcon } from '../stores/virusHuntStore';
import { ScanMode, ScanModeCard } from '../types/virushunt';
import { ScanProgress, ScanResult, FileScanResult } from '../../shared/virushunt-types';
import { Button } from './Button';
import { Toggle } from './Toggle';
import { SecuritySettings } from './Settings/SecuritySettings';
import './VirusHunt.css';

const VirusHunt: React.FC = () => {
  const {
    settings,
    updateSettings,
    selectedMode,
    setMode,
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

  const [selectedPath, setSelectedPath] = useState<string>('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string>('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const scanStartTimeRef = useRef<number>(0);

  // Initialize VirusHunt on mount
  useEffect(() => {
    const init = async () => {
      try {
        await window.api.virusHunt.initialize();
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize VirusHunt:', error);
        setInitError(error instanceof Error ? error.message : 'Initialization failed');
        addError({
          code: 'INIT_ERROR',
          message: 'Failed to initialize VirusHunt',
          details: error instanceof Error ? error.message : undefined,
        });
      }
    };

    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to scan progress events
  useEffect(() => {
    const unsubscribeProgress = window.api.virusHunt.onScanProgress((progress: ScanProgress) => {
      setScanState({
        progress: progress.progress,
        currentFile: progress.currentFile,
        filesScanned: progress.scannedFiles,
        filesTotal: progress.totalFiles,
      });
    });

    const unsubscribeComplete = window.api.virusHunt.onScanComplete((data: { scanId: string; result: ScanResult }) => {
      const scanTime = (Date.now() - scanStartTimeRef.current) / 1000;
      const stats = categorizeScanResults(data.result.fileResults as any);
      stats.scanTime = scanTime;

      updateStatistics(stats);
      setScanState({
        isScanning: false,
        progress: 100,
        results: data.result.fileResults as any,
      });

      // Add to history
      addToHistory({
        id: data.scanId,
        mode: selectedMode,
        statistics: stats,
      });

      // Convert results to FileResult format
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

    const unsubscribeError = window.api.virusHunt.onScanError((data: { scanId: string; error: string }) => {
      setScanState({
        isScanning: false,
      });
      addError({
        code: 'SCAN_ERROR',
        message: data.error,
      });
    });

    return () => {
      unsubscribeProgress();
      unsubscribeComplete();
      unsubscribeError();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scan mode cards configuration
  const scanModeCards: ScanModeCard[] = [
    {
      id: 'downloads',
      title: 'Скачанные торренты',
      description: 'Проверить все загруженные файлы',
      icon: <HiDownload className="scan-mode-icon" />,
      available: true,
    },
    {
      id: 'folder',
      title: 'Выбрать папку',
      description: 'Сканировать выбранную директорию',
      icon: <HiFolder className="scan-mode-icon" />,
      available: true,
    },
    {
      id: 'file',
      title: 'Выбрать файл',
      description: 'Проверить один файл',
      icon: <HiDocumentText className="scan-mode-icon" />,
      available: true,
    },
  ];

  // Handle mode selection
  const handleModeSelect = async (mode: ScanMode) => {
    setMode(mode);
    setSelectedPath('');

    if (mode === 'folder') {
      try {
        const result = await window.api.dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Выберите папку для сканирования',
        });

        if (!result.canceled && result.filePaths.length > 0) {
          setSelectedPath(result.filePaths[0]);
        }
      } catch (error) {
        console.error('Failed to select folder:', error);
        addError({
          code: 'DIALOG_ERROR',
          message: 'Не удалось открыть диалог выбора папки',
        });
      }
    } else if (mode === 'file') {
      try {
        const result = await window.api.dialog.showOpenDialog({
          properties: ['openFile'],
          title: 'Выберите файл для сканирования',
          filters: [
            { name: 'Executable Files', extensions: ['exe', 'dll', 'msi'] },
            { name: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz'] },
            { name: 'Scripts', extensions: ['bat', 'cmd', 'ps1', 'vbs', 'js'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if (!result.canceled && result.filePaths.length > 0) {
          setSelectedPath(result.filePaths[0]);
        }
      } catch (error) {
        console.error('Failed to select file:', error);
        addError({
          code: 'DIALOG_ERROR',
          message: 'Не удалось открыть диалог выбора файла',
        });
      }
    }
  };

  // Start scan
  const handleStartScan = useCallback(async () => {
    if (scanState.isScanning) return;

    // Validate scan requirements
    if (selectedMode !== 'downloads' && !selectedPath) {
      addError({
        code: 'NO_PATH',
        message: 'Выберите файл или папку для сканирования',
      });
      return;
    }

    try {
      resetScanState();
      resetStatistics();
      clearResults();

      setScanState({
        isScanning: true,
        progress: 0,
        currentFile: '',
        filesScanned: 0,
        filesTotal: 0,
      });

      scanStartTimeRef.current = Date.now();

      // Determine paths to scan
      let pathsToScan: string[] = [];
      if (selectedMode === 'downloads') {
        // Get downloads directory from settings
        const appSettings = await window.api.getSettings();
        pathsToScan = [appSettings.defaultDownloadDir || ''];
      } else if (selectedPath) {
        pathsToScan = [selectedPath];
      }

      if (pathsToScan.length === 0 || !pathsToScan[0]) {
        throw new Error('Выберите путь для сканирования или настройте директорию загрузок');
      }

      const scanOptions: any = {
        paths: pathsToScan,
        deepScan: settings.deepScan,
        enableHeuristics: true,
        timeout: 30000, // 30 seconds per file
      };

      const result = await window.api.virusHunt.startScan(scanOptions);
      setScanState({ scanId: result.scanId });
    } catch (error) {
      console.error('Failed to start scan:', error);
      setScanState({ isScanning: false });
      addError({
        code: 'START_SCAN_ERROR',
        message: 'Не удалось запустить сканирование',
        details: error instanceof Error ? error.message : undefined,
      });
    }
  }, [
    selectedMode,
    selectedPath,
    settings,
    scanState.isScanning,
    setScanState,
    resetScanState,
    resetStatistics,
    clearResults,
    addError,
  ]);

  // Cancel scan
  const handleCancelScan = useCallback(async () => {
    if (!scanState.scanId) return;

    try {
      await window.api.virusHunt.cancelScan(scanState.scanId);
      setScanState({ isScanning: false });
    } catch (error) {
      console.error('Failed to cancel scan:', error);
      addError({
        code: 'CANCEL_SCAN_ERROR',
        message: 'Не удалось отменить сканирование',
      });
    }
  }, [scanState.scanId, setScanState, addError]);

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  // Format time
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
  };

  if (!isInitialized) {
    return (
      <div className="virushunt-container">
        <div className="virushunt-loading">
          <HiShieldCheck className="virushunt-loading-icon" />
          {initError ? (
            <>
              <h2>Ошибка инициализации</h2>
              <p className="error-message">{initError}</p>
            </>
          ) : (
            <>
              <h2>Инициализация VirusHunt...</h2>
              <div className="spinner" />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="virushunt-container">
      {/* Header */}
      <div className="virushunt-header">
        <div className="virushunt-title">
          <HiShieldCheck className="virushunt-title-icon" />
          <h1>VirusHunt</h1>
          <span className="virushunt-subtitle">Advanced Security Scanner</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<HiCog />}
          onClick={() => setIsSettingsOpen(true)}
        >
          Настройки
        </Button>
      </div>

      {/* Scan Mode Section */}
      <section className="virushunt-section">
        <h2 className="section-title">Режим сканирования</h2>
        <div className="scan-modes">
          {scanModeCards.map((card) => (
            <motion.button
              key={card.id}
              className={`scan-mode-card ${selectedMode === card.id ? 'active' : ''} ${
                !card.available ? 'disabled' : ''
              }`}
              onClick={() => card.available && handleModeSelect(card.id)}
              disabled={!card.available || scanState.isScanning}
              whileHover={card.available ? { scale: 1.02, y: -2 } : {}}
              whileTap={card.available ? { scale: 0.98 } : {}}
              transition={{ duration: 0.2 }}
            >
              <div className="scan-mode-icon-wrapper">{card.icon}</div>
              <div className="scan-mode-content">
                <h3>{card.title}</h3>
                <p>{card.description}</p>
              </div>
              {selectedMode === card.id && (
                <motion.div
                  className="scan-mode-check"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  <HiCheckCircle />
                </motion.div>
              )}
            </motion.button>
          ))}
        </div>

        {selectedPath && (
          <motion.div
            className="selected-path"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <HiFolder className="path-icon" />
            <span className="path-text">{selectedPath}</span>
          </motion.div>
        )}
      </section>

      {/* Settings Section */}
      <section className="virushunt-section">
        <h2 className="section-title">Параметры сканирования</h2>

        <div className="scan-settings">
          {/* Scan Mode Settings */}
          <div className="settings-group">
            <div className="setting-item">
              <div className="setting-info">
                <label htmlFor="deep-scan">Глубокое сканирование</label>
                <span className="setting-description">
                  PE анализ, энтропия, проверка цифровых подписей и эвристический анализ
                </span>
              </div>
              <Toggle
                checked={settings.deepScan}
                onChange={(checked) => updateSettings({ deepScan: checked })}
                disabled={scanState.isScanning}
              />
            </div>

            <div className="setting-item">
              <div className="setting-info">
                <label htmlFor="auto-check">Автоматическая проверка</label>
                <span className="setting-description">
                  Проверять файлы автоматически при скачивании торрентов
                </span>
              </div>
              <Toggle
                checked={settings.autoCheck}
                onChange={(checked) => updateSettings({ autoCheck: checked })}
                disabled={scanState.isScanning}
              />
            </div>
          </div>

          {/* Sensitivity Slider */}
          <div className="settings-group">
            <div className="setting-item sensitivity-setting">
              <div className="setting-info">
                <label htmlFor="sensitivity">
                  Чувствительность эвристики: {settings.sensitivity}%
                </label>
                <span className="setting-description">
                  Порог срабатывания эвристических правил - чем выше, тем больше потенциальных угроз будет обнаружено
                </span>
              </div>
              <div className="slider-container">
                <input
                  type="range"
                  id="sensitivity"
                  min="0"
                  max="100"
                  value={settings.sensitivity}
                  onChange={(e) => updateSettings({ sensitivity: parseInt(e.target.value) })}
                  disabled={scanState.isScanning}
                  className="sensitivity-slider"
                />
                <div className="slider-labels">
                  <span>Низкая (меньше ложных срабатываний)</span>
                  <span>Средняя</span>
                  <span>Высокая (более строгая проверка)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Control Section */}
      <section className="virushunt-section">
        <h2 className="section-title">Управление</h2>

        <div className="scan-controls">
          <AnimatePresence mode="wait">
            {!scanState.isScanning ? (
              <motion.div
                key="start"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="control-button-wrapper"
              >
                <Button
                  variant="primary"
                  size="lg"
                  icon={<HiPlay />}
                  onClick={handleStartScan}
                  className="scan-button"
                  disabled={selectedMode !== 'downloads' && !selectedPath}
                >
                  Начать сканирование
                </Button>
              </motion.div>
            ) : (
              <motion.div
                key="scanning"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="scanning-controls"
              >
                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-header">
                    <span className="progress-label">
                      {scanState.filesScanned} / {scanState.filesTotal} файлов
                    </span>
                    <span className="progress-percent">{scanState.progress.toFixed(0)}%</span>
                  </div>
                  <div className="progress-bar">
                    <motion.div
                      className="progress-fill"
                      initial={{ width: 0 }}
                      animate={{ width: `${scanState.progress}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  {scanState.currentFile && (
                    <div className="current-file">
                      <span className="current-file-label">Сканируется:</span>
                      <span className="current-file-name" title={scanState.currentFile}>
                        {scanState.currentFile.split(/[/\\]/).pop()}
                      </span>
                    </div>
                  )}
                </div>

                {/* Cancel Button */}
                <Button
                  variant="danger"
                  size="lg"
                  icon={<HiStop />}
                  onClick={handleCancelScan}
                  className="cancel-button"
                >
                  Отменить
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Statistics */}
        {(scanState.isScanning || statistics.totalFiles > 0) && (
          <motion.div
            className="scan-statistics"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="stat-cards">
              <div className="stat-card safe">
                <HiCheckCircle className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.safeFiles}</span>
                  <span className="stat-label">Безопасно</span>
                </div>
              </div>

              <div className="stat-card threats">
                <HiExclamation className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.threatsFound}</span>
                  <span className="stat-label">Угрозы</span>
                </div>
              </div>

              <div className="stat-card cracks">
                <FiLock className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.cracksFound}</span>
                  <span className="stat-label">Кряки</span>
                </div>
              </div>

              <div className="stat-card keygens">
                <FiKey className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.keygensFound}</span>
                  <span className="stat-label">Кейгены</span>
                </div>
              </div>

              <div className="stat-card suspicious">
                <FiAlertTriangle className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.suspiciousFiles}</span>
                  <span className="stat-label">Подозрительно</span>
                </div>
              </div>

              <div className="stat-card dangerous">
                <HiXCircle className="stat-icon" />
                <div className="stat-content">
                  <span className="stat-value">{statistics.dangerousFiles}</span>
                  <span className="stat-label">Опасно</span>
                </div>
              </div>
            </div>

            {!scanState.isScanning && statistics.totalFiles > 0 && (
              <div className="scan-summary">
                <div className="summary-item">
                  <span className="summary-label">Всего файлов:</span>
                  <span className="summary-value">{statistics.totalFiles}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Размер:</span>
                  <span className="summary-value">{formatSize(statistics.scannedSize)}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Время:</span>
                  <span className="summary-value">{formatTime(statistics.scanTime)}</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </section>

      {/* Results Section */}
      {!scanState.isScanning && results.length > 0 && (
        <motion.section
          className="virushunt-section results-section"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="results-header">
            <h2 className="section-title">Результаты сканирования</h2>
            <Button variant="secondary" size="sm" onClick={clearResults}>
              Очистить
            </Button>
          </div>

          <div className="results-list">
            {results.map((result, index) => (
              <motion.div
                key={`${result.path}-${index}`}
                className={`result-item result-${result.category}`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <div className="result-icon" style={{ color: getThreatColor(result.category) }}>
                  {getThreatIcon(result.category)}
                </div>
                <div className="result-content">
                  <div className="result-path" title={result.path}>
                    {result.path.split(/[/\\]/).pop()}
                  </div>
                  <div className="result-meta">
                    <span className="result-category">{result.category.toUpperCase()}</span>
                    <span className="result-risk">Риск: {result.riskScore}/100</span>
                    {result.threats.length > 0 && (
                      <span className="result-threats">{result.threats.join(', ')}</span>
                    )}
                  </div>
                </div>
                <div className="result-actions">
                  {/* Add action buttons here */}
                </div>
              </motion.div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Settings Modal */}
      <Transition appear show={isSettingsOpen} as={Fragment}>
        <Dialog as="div" className="virushunt-settings-dialog" onClose={() => setIsSettingsOpen(false)}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="virushunt-dialog-backdrop" />
          </Transition.Child>

          <div className="virushunt-dialog-container">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="virushunt-dialog-panel">
                <div className="virushunt-dialog-header">
                  <Dialog.Title as="h2" className="virushunt-dialog-title">
                    <HiCog className="virushunt-dialog-icon" />
                    Настройки VirusHunt
                  </Dialog.Title>
                  <button
                    onClick={() => setIsSettingsOpen(false)}
                    className="virushunt-dialog-close"
                  >
                    <HiX />
                  </button>
                </div>
                <div className="virushunt-dialog-content">
                  <SecuritySettings onClose={() => setIsSettingsOpen(false)} />
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
};

export default VirusHunt;
