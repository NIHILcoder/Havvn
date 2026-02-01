/**
 * SecuritySettingsSimple - Simplified Security Settings
 * Single page with all important settings in collapsible sections
 */

import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  FiShield,
  FiFile,
  FiCpu,
  FiBell,
  FiZap,
  FiSave,
  FiRotateCcw,
  FiChevronDown,
  FiCheck,
  FiX,
  FiPlus,
} from 'react-icons/fi';
import { Button } from './Button';
import { Toggle } from './Toggle';
import './SecuritySettingsSimple.css';

interface SecuritySettingsSimpleProps {
  onClose?: () => void;
}

interface Settings {
  // Core
  enabled: boolean;
  autoScan: boolean;
  sensitivity: number;
  
  // File Types
  scanExecutables: boolean;
  scanArchives: boolean;
  scanScripts: boolean;
  scanDocuments: boolean;
  skipExtensions: string[];
  
  // Heuristics
  heuristicsEnabled: boolean;
  entropyCheck: boolean;
  signatureCheck: boolean;
  peAnalysis: boolean;
  
  // Notifications
  notifyOnThreats: boolean;
  notifySound: boolean;
  
  // Performance
  parallelScans: number;
  maxFileSize: number; // MB
}

const defaultSettings: Settings = {
  enabled: true,
  autoScan: true,
  sensitivity: 50,
  scanExecutables: true,
  scanArchives: true,
  scanScripts: true,
  scanDocuments: false,
  skipExtensions: ['.txt', '.jpg', '.png', '.mp3', '.mp4'],
  heuristicsEnabled: true,
  entropyCheck: true,
  signatureCheck: true,
  peAnalysis: true,
  notifyOnThreats: true,
  notifySound: true,
  parallelScans: 4,
  maxFileSize: 100,
};

// Section component - DEFINED OUTSIDE to prevent re-renders
interface SectionProps {
  id: string;
  icon: React.ReactNode;
  title: string;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

const Section = memo<SectionProps>(({ id, icon, title, isExpanded, onToggle, children }) => (
  <div className="sss-section">
    <button className="sss-section-header" onClick={() => onToggle(id)}>
      <div className="sss-section-title">
        {icon}
        <span>{title}</span>
      </div>
      <FiChevronDown className={`sss-chevron ${isExpanded ? 'open' : ''}`} />
    </button>
    <div className={`sss-section-content ${isExpanded ? 'expanded' : ''}`}>
      <div className="sss-section-inner">
        {children}
      </div>
    </div>
  </div>
));

Section.displayName = 'Section';

export const SecuritySettingsSimple: React.FC<SecuritySettingsSimpleProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [expandedSection, setExpandedSection] = useState<string | null>('core');
  const [newExtension, setNewExtension] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Load settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const saved = await window.api.virusHuntSettings.getSettings();
        if (saved) {
          setSettings({
            enabled: saved.enabled ?? true,
            autoScan: saved.autoScanAfterDownload ?? true,
            sensitivity: saved.sensitivity ?? 50,
            scanExecutables: saved.fileTypes?.executable ?? true,
            scanArchives: saved.fileTypes?.archive ?? true,
            scanScripts: saved.fileTypes?.script ?? true,
            scanDocuments: saved.fileTypes?.document ?? false,
            skipExtensions: saved.fileTypes?.exclusionList ?? defaultSettings.skipExtensions,
            heuristicsEnabled: saved.heuristics?.enabled ?? true,
            entropyCheck: saved.heuristics?.checkEntropy ?? true,
            signatureCheck: saved.heuristics?.checkSignatures ?? true,
            peAnalysis: saved.heuristics?.checkPEStructure ?? true,
            notifyOnThreats: saved.notifications?.enabled ?? true,
            notifySound: saved.notifications?.soundEnabled ?? true,
            parallelScans: saved.performance?.parallelScans ?? 4,
            maxFileSize: (saved.performance?.maxMemoryUsage ?? 100),
          });
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        showToast('error', 'Не удалось загрузить настройки');
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await window.api.virusHuntSettings.updateSettings({
        enabled: settings.enabled,
        autoScanAfterDownload: settings.autoScan,
        sensitivity: settings.sensitivity,
        fileTypes: {
          executable: settings.scanExecutables,
          archive: settings.scanArchives,
          script: settings.scanScripts,
          document: settings.scanDocuments,
          media: false,
          customExtensions: [],
          exclusionList: settings.skipExtensions,
        },
        heuristics: {
          enabled: settings.heuristicsEnabled,
          entropyThreshold: 7.0,
          suspiciousImportsThreshold: 5,
          riskScoreThreshold: 70,
          checkPEStructure: settings.peAnalysis,
          checkEntropy: settings.entropyCheck,
          checkSignatures: settings.signatureCheck,
          checkStrings: true,
          checkBehavior: true,
          customRulesPath: '',
        },
        notifications: {
          enabled: settings.notifyOnThreats,
          soundEnabled: settings.notifySound,
          notificationType: 'threats-only',
          priority: 'normal',
          showDesktop: true,
          showInApp: true,
        },
        performance: {
          parallelScans: settings.parallelScans,
          backgroundPriority: true,
          scheduledScans: [],
          maxMemoryUsage: settings.maxFileSize,
          cpuLimit: 50,
        },
      });
      setHasChanges(false);
      showToast('success', 'Настройки сохранены');
    } catch (error) {
      console.error('Failed to save settings:', error);
      showToast('error', 'Не удалось сохранить настройки');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Сбросить все настройки?')) return;
    try {
      await window.api.virusHuntSettings.resetSettings();
      setSettings(defaultSettings);
      setHasChanges(false);
      showToast('success', 'Настройки сброшены');
    } catch (error) {
      showToast('error', 'Ошибка сброса настроек');
    }
  };

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const toggleSection = (id: string) => {
    setExpandedSection(expandedSection === id ? null : id);
  };

  const addExtension = () => {
    const ext = newExtension.trim();
    if (ext && (ext.startsWith('.') || ext.length > 0)) {
      const formattedExt = ext.startsWith('.') ? ext : `.${ext}`;
      if (!settings.skipExtensions.includes(formattedExt)) {
        updateSetting('skipExtensions', [...settings.skipExtensions, formattedExt]);
        setNewExtension('');
      }
    }
  };

  const removeExtension = (ext: string) => {
    updateSetting('skipExtensions', settings.skipExtensions.filter(e => e !== ext));
  };

  if (isLoading) {
    return (
      <div className="sss-loading">
        <div className="sss-spinner" />
        <span>Загрузка настроек...</span>
      </div>
    );
  }

  return (
    <div className="sss-container">
      {/* Header */}
      <div className="sss-header">
        <div className="sss-header-title">
          <FiShield />
          <span>Настройки безопасности</span>
        </div>
        <div className="sss-header-actions">
          <Button variant="ghost" size="sm" icon={<FiRotateCcw />} onClick={handleReset}>
            Сброс
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<FiSave />}
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            loading={isSaving}
          >
            Сохранить
          </Button>
        </div>
      </div>

      {hasChanges && (
        <div className="sss-unsaved">
          Есть несохранённые изменения
        </div>
      )}

      {/* Core Settings */}
      <Section id="core" icon={<FiShield />} title="Основные" isExpanded={expandedSection === 'core'} onToggle={toggleSection}>
        <div className="sss-row">
          <div className="sss-row-info">
            <span className="sss-label">Защита включена</span>
            <span className="sss-desc">Главный переключатель VirusHunt</span>
          </div>
          <Toggle checked={settings.enabled} onChange={(v) => updateSetting('enabled', v)} />
        </div>

        <div className="sss-row">
          <div className="sss-row-info">
            <span className="sss-label">Авто-сканирование</span>
            <span className="sss-desc">Проверять файлы после загрузки</span>
          </div>
          <Toggle checked={settings.autoScan} onChange={(v) => updateSetting('autoScan', v)} />
        </div>

        <div className="sss-row sss-row-column">
          <div className="sss-row-info">
            <span className="sss-label">Чувствительность: {settings.sensitivity}%</span>
            <span className="sss-desc">Порог срабатывания эвристики</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={settings.sensitivity}
            onChange={(e) => updateSetting('sensitivity', parseInt(e.target.value))}
            className="sss-slider"
          />
          <div className="sss-slider-labels">
            <span>Низкая</span>
            <span>Средняя</span>
            <span>Высокая</span>
          </div>
        </div>
      </Section>

      {/* File Types */}
      <Section id="files" icon={<FiFile />} title="Типы файлов" isExpanded={expandedSection === 'files'} onToggle={toggleSection}>
        <div className="sss-row">
          <span className="sss-label">Исполняемые (.exe, .dll)</span>
          <Toggle checked={settings.scanExecutables} onChange={(v) => updateSetting('scanExecutables', v)} />
        </div>
        <div className="sss-row">
          <span className="sss-label">Архивы (.zip, .rar, .7z)</span>
          <Toggle checked={settings.scanArchives} onChange={(v) => updateSetting('scanArchives', v)} />
        </div>
        <div className="sss-row">
          <span className="sss-label">Скрипты (.bat, .ps1, .vbs)</span>
          <Toggle checked={settings.scanScripts} onChange={(v) => updateSetting('scanScripts', v)} />
        </div>
        <div className="sss-row">
          <span className="sss-label">Документы (.pdf, .doc)</span>
          <Toggle checked={settings.scanDocuments} onChange={(v) => updateSetting('scanDocuments', v)} />
        </div>

        <div className="sss-divider" />

        <div className="sss-row-column">
          <span className="sss-label">Пропускать расширения:</span>
          <div className="sss-tags">
            {settings.skipExtensions.map(ext => (
              <div key={ext} className="sss-tag">
                <span>{ext}</span>
                <button onClick={() => removeExtension(ext)}><FiX /></button>
              </div>
            ))}
          </div>
          <div className="sss-add-tag">
            <input
              type="text"
              placeholder=".txt"
              value={newExtension}
              onChange={(e) => setNewExtension(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && addExtension()}
            />
            <Button variant="secondary" size="sm" icon={<FiPlus />} onClick={addExtension}>
              Добавить
            </Button>
          </div>
        </div>
      </Section>

      {/* Heuristics */}
      <Section id="heuristics" icon={<FiCpu />} title="Эвристика" isExpanded={expandedSection === 'heuristics'} onToggle={toggleSection}>
        <div className="sss-row">
          <div className="sss-row-info">
            <span className="sss-label">Эвристический анализ</span>
            <span className="sss-desc">Обнаружение неизвестных угроз</span>
          </div>
          <Toggle checked={settings.heuristicsEnabled} onChange={(v) => updateSetting('heuristicsEnabled', v)} />
        </div>

        {settings.heuristicsEnabled && (
          <>
            <div className="sss-row">
              <span className="sss-label">Анализ энтропии</span>
              <Toggle checked={settings.entropyCheck} onChange={(v) => updateSetting('entropyCheck', v)} />
            </div>
            <div className="sss-row">
              <span className="sss-label">Проверка подписей</span>
              <Toggle checked={settings.signatureCheck} onChange={(v) => updateSetting('signatureCheck', v)} />
            </div>
            <div className="sss-row">
              <span className="sss-label">PE-анализ структуры</span>
              <Toggle checked={settings.peAnalysis} onChange={(v) => updateSetting('peAnalysis', v)} />
            </div>
          </>
        )}
      </Section>

      {/* Notifications */}
      <Section id="notifications" icon={<FiBell />} title="Уведомления" isExpanded={expandedSection === 'notifications'} onToggle={toggleSection}>
        <div className="sss-row">
          <span className="sss-label">Уведомлять об угрозах</span>
          <Toggle checked={settings.notifyOnThreats} onChange={(v) => updateSetting('notifyOnThreats', v)} />
        </div>
        <div className="sss-row">
          <span className="sss-label">Звуковые уведомления</span>
          <Toggle checked={settings.notifySound} onChange={(v) => updateSetting('notifySound', v)} />
        </div>
      </Section>

      {/* Performance */}
      <Section id="performance" icon={<FiZap />} title="Производительность" isExpanded={expandedSection === 'performance'} onToggle={toggleSection}>
        <div className="sss-row sss-row-column">
          <div className="sss-row-info">
            <span className="sss-label">Параллельных сканирований: {settings.parallelScans}</span>
            <span className="sss-desc">Больше = быстрее, но выше нагрузка</span>
          </div>
          <input
            type="range"
            min="1"
            max="10"
            value={settings.parallelScans}
            onChange={(e) => updateSetting('parallelScans', parseInt(e.target.value))}
            className="sss-slider"
          />
        </div>

        <div className="sss-row sss-row-column">
          <div className="sss-row-info">
            <span className="sss-label">Макс. размер файла: {settings.maxFileSize} МБ</span>
            <span className="sss-desc">Файлы больше будут пропущены</span>
          </div>
          <input
            type="range"
            min="10"
            max="500"
            step="10"
            value={settings.maxFileSize}
            onChange={(e) => updateSetting('maxFileSize', parseInt(e.target.value))}
            className="sss-slider"
          />
        </div>
      </Section>

      {/* Toast */}
      {toast && (
        <div className={`sss-toast sss-toast-${toast.type}`}>
          {toast.type === 'success' ? <FiCheck /> : <FiX />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
};

export default SecuritySettingsSimple;
