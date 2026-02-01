/**
 * SecuritySettings Component
 * Comprehensive VirusHunt settings with tabs and form validation
 */

import React, { useState, useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { virusHuntSettingsSchema } from '../../../shared/virushunt-settings-schema';
import { VirusHuntSettings, DEFAULT_VIRUSHUNT_SETTINGS } from '../../../shared/virushunt-settings-types';
import { Tab } from '@headlessui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FiShield, 
  FiFile, 
  FiCpu, 
  FiDatabase, 
  FiUsers, 
  FiBell, 
  FiZap, 
  FiSlash, 
  FiSettings,
  FiSave,
  FiRotateCcw,
  FiDownload,
  FiUpload,
  FiCheckCircle,
  FiAlertCircle,
} from 'react-icons/fi';
import './SecuritySettings.css';

// Import section components
import { CoreSettings } from './sections/CoreSettings';
import { FileTypesSettings } from './sections/FileTypesSettings';
import { HeuristicsSettings } from './sections/HeuristicsSettings';
import { DatabaseSettings } from './sections/DatabaseSettings';
import { CrowdsourcingSettings } from './sections/CrowdsourcingSettings';
import { NotificationSettings } from './sections/NotificationSettings';
import { PerformanceSettings } from './sections/PerformanceSettings';
import { ExclusionsSettings } from './sections/ExclusionsSettings';
import { AdvancedSettings } from './sections/AdvancedSettings';
import { Button } from '../Button';
import { Toast } from '../Toast';

interface SecuritySettingsProps {
  onClose?: () => void;
}

interface TabItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  component: React.ComponentType<any>;
}

const tabs: TabItem[] = [
  { id: 'core', label: 'Core', icon: FiShield, component: CoreSettings },
  { id: 'fileTypes', label: 'File Types', icon: FiFile, component: FileTypesSettings },
  { id: 'heuristics', label: 'Heuristics', icon: FiCpu, component: HeuristicsSettings },
  { id: 'databases', label: 'Databases', icon: FiDatabase, component: DatabaseSettings },
  { id: 'crowdsourcing', label: 'Crowdsourcing', icon: FiUsers, component: CrowdsourcingSettings },
  { id: 'notifications', label: 'Notifications', icon: FiBell, component: NotificationSettings },
  { id: 'performance', label: 'Performance', icon: FiZap, component: PerformanceSettings },
  { id: 'exclusions', label: 'Exclusions', icon: FiSlash, component: ExclusionsSettings },
  { id: 'advanced', label: 'Advanced', icon: FiSettings, component: AdvancedSettings },
];

export const SecuritySettings: React.FC<SecuritySettingsProps> = ({ onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // React Hook Form setup
  const methods = useForm<VirusHuntSettings>({
    resolver: zodResolver(virusHuntSettingsSchema),
    defaultValues: DEFAULT_VIRUSHUNT_SETTINGS,
    mode: 'onChange',
  });

  const { handleSubmit, reset, formState: { isDirty, isValid, errors } } = methods;

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const settings = await window.api.virusHuntSettings.getSettings();
      reset(settings);
      showToast('success', 'Settings loaded successfully');
    } catch (error) {
      console.error('Failed to load settings:', error);
      showToast('error', 'Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (data: VirusHuntSettings) => {
    setIsSaving(true);
    try {
      const result = await window.api.virusHuntSettings.updateSettings(data);
      
      if (result.success) {
        reset(result.updatedSettings);
        showToast('success', 'Settings saved successfully');
      } else {
        showToast('error', result.message || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      showToast('error', 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Are you sure you want to reset all settings to defaults?')) {
      return;
    }

    setIsSaving(true);
    try {
      const result = await window.api.virusHuntSettings.resetSettings();
      
      if (result.success && result.updatedSettings) {
        reset(result.updatedSettings);
        showToast('success', 'Settings reset to defaults');
      } else {
        showToast('error', 'Failed to reset settings');
      }
    } catch (error) {
      console.error('Failed to reset settings:', error);
      showToast('error', 'Failed to reset settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async () => {
    try {
      const result = await window.api.virusHuntSettings.exportSettings();
      
      if (result.success) {
        showToast('success', `Settings exported to ${result.path}`);
      } else {
        showToast('error', result.message || 'Export canceled');
      }
    } catch (error) {
      console.error('Failed to export settings:', error);
      showToast('error', 'Failed to export settings');
    }
  };

  const handleImport = async () => {
    try {
      const result = await window.api.virusHuntSettings.importSettings();
      
      if (result.success && result.updatedSettings) {
        reset(result.updatedSettings);
        showToast('success', 'Settings imported successfully');
      } else {
        showToast('error', result.message || 'Import canceled');
      }
    } catch (error) {
      console.error('Failed to import settings:', error);
      showToast('error', 'Failed to import settings');
    }
  };

  const showToast = (type: 'success' | 'error' | 'info', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  };

  if (isLoading) {
    return (
      <div className="security-settings-loading">
        <div className="spinner" />
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <FormProvider {...methods}>
      <div className="security-settings">
        <div className="security-settings-header">
          <div className="header-left">
            <FiShield className="header-icon" />
            <div>
              <h1>VirusHunt Security Settings</h1>
              <p>Configure malware detection, scanning behavior, and protection features</p>
            </div>
          </div>
          
          <div className="header-actions">
            <Button 
              variant="secondary" 
              onClick={handleExport}
              disabled={isSaving}
              icon={<FiDownload />}
            >
              Export
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleImport}
              disabled={isSaving}
              icon={<FiUpload />}
            >
              Import
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleReset}
              disabled={isSaving}
              icon={<FiRotateCcw />}
            >
              Reset to Defaults
            </Button>
            <Button 
              variant="primary" 
              onClick={handleSubmit(onSubmit)}
              disabled={!isDirty || !isValid || isSaving}
              loading={isSaving}
              icon={<FiSave />}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>

        {/* Validation errors summary */}
        {Object.keys(errors).length > 0 && (
          <div className="validation-errors">
            <FiAlertCircle className="error-icon" />
            <div>
              <p className="error-title">Please fix the following errors:</p>
              <ul>
                {Object.entries(errors).map(([key, error]) => (
                  <li key={key}>{error?.message as string}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Unsaved changes indicator */}
        {isDirty && (
          <div className="unsaved-changes">
            <FiAlertCircle className="warning-icon" />
            <span>You have unsaved changes</span>
          </div>
        )}

        <Tab.Group selectedIndex={selectedTab} onChange={setSelectedTab}>
          <div className="settings-layout">
            {/* Sidebar with tabs */}
            <Tab.List className="settings-sidebar">
              {tabs.map((tab) => (
                <Tab key={tab.id} className="tab-button">
                  {({ selected }) => (
                    <motion.div
                      className={`tab-content ${selected ? 'selected' : ''}`}
                      whileHover={{ x: 4 }}
                      transition={{ duration: 0.2 }}
                    >
                      <tab.icon className="tab-icon" />
                      <span>{tab.label}</span>
                      {selected && (
                        <motion.div
                          className="tab-indicator"
                          layoutId="tab-indicator"
                          initial={false}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        />
                      )}
                    </motion.div>
                  )}
                </Tab>
              ))}
            </Tab.List>

            {/* Main content area */}
            <Tab.Panels className="settings-content">
              <AnimatePresence mode="wait">
                {tabs.map((tab, index) => (
                  <Tab.Panel key={tab.id}>
                    {selectedTab === index && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                        className="panel-content"
                      >
                        <div className="panel-header">
                          <tab.icon className="panel-icon" />
                          <h2>{tab.label} Settings</h2>
                        </div>
                        <tab.component />
                      </motion.div>
                    )}
                  </Tab.Panel>
                ))}
              </AnimatePresence>
            </Tab.Panels>
          </div>
        </Tab.Group>

        {/* Toast notifications */}
        <AnimatePresence>
          {toast && (
            <Toast
              id="security-settings-toast"
              variant={toast.type}
              message={toast.message}
              onClose={() => setToast(null)}
            />
          )}
        </AnimatePresence>
      </div>
    </FormProvider>
  );
};
