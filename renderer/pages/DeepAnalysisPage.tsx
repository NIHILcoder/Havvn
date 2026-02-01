/**
 * Deep Analysis Page
 * Advanced malware analysis with YARA, Import Table, Packer Detection, String Signatures
 */

import React, { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HiShieldCheck,
  HiDocumentText,
  HiRefresh,
  HiDownload,
  HiChevronRight,
  HiCheckCircle,
  HiExclamation,
  HiXCircle,
} from 'react-icons/hi';
import { FiCpu, FiSearch, FiAlertTriangle, FiZap, FiPackage, FiCode, FiFileText } from 'react-icons/fi';
import { DeepAnalysisResult } from '../../shared/virushunt-types';
import { Button } from '../components/Button';
import './DeepAnalysisPage.css';

interface AnalysisHistoryItem {
  id: string;
  fileName: string;
  filePath: string;
  result: DeepAnalysisResult;
  timestamp: number;
}

const DeepAnalysisPage: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentResult, setCurrentResult] = useState<DeepAnalysisResult | null>(null);
  const [history, setHistory] = useState<AnalysisHistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [analysisProgress, setAnalysisProgress] = useState<{ progress: number; message: string }>({ progress: 0, message: '' });

  // Select file for analysis
  const handleSelectFile = async () => {
    try {
      const result = await window.api.dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Выберите файл для глубокого анализа',
        filters: [
          { name: 'Executables', extensions: ['exe', 'dll', 'msi', 'sys', 'scr'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      
      if (!result.canceled && result.filePaths.length > 0) {
        setSelectedFile(result.filePaths[0]);
        setError('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выбора файла');
    }
  };

  // Listen for progress updates
  useEffect(() => {
    const handleProgress = (data: { progress: number; message: string }) => {
      setAnalysisProgress(data);
    };
    
    window.api.on('virushunt:deep-scan-progress', handleProgress);
    
    return () => {
      window.api.off('virushunt:deep-scan-progress', handleProgress);
    };
  }, []);

  // Start deep analysis
  const handleAnalyze = async () => {
    if (!selectedFile) {
      setError('Выберите файл для анализа');
      return;
    }

    try {
      setIsAnalyzing(true);
      setError('');
      setCurrentResult(null);
      setAnalysisProgress({ progress: 0, message: 'Начало анализа...' });
      
      const result = await window.api.virusHunt.deepScanFile(selectedFile);
      
      if (result.success && result.result) {
        setCurrentResult(result.result);
        
        // Add to history
        const historyItem: AnalysisHistoryItem = {
          id: `${Date.now()}-${Math.random()}`,
          fileName: selectedFile.split(/[/\\]/).pop() || 'unknown',
          filePath: selectedFile,
          result: result.result,
          timestamp: Date.now(),
        };
        
        setHistory(prev => [historyItem, ...prev.slice(0, 9)]); // Keep last 10
        setSelectedHistoryId(historyItem.id);
      } else {
        // Specific error messages with icons
        const errorMsg = result.error || 'Ошибка анализа';
        
        if (errorMsg.includes('timeout')) {
          setError(`⏱️ ${errorMsg}\n\nФайл слишком сложный для анализа.`);
        } else {
          setError(errorMsg);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка анализа');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress({ progress: 0, message: '' });
    }
  };

  // Load result from history
  const handleLoadHistory = (item: AnalysisHistoryItem) => {
    setCurrentResult(item.result);
    setSelectedHistoryId(item.id);
    setSelectedFile(item.filePath);
    setError('');
  };

  // Export report
  const handleExportReport = async () => {
    if (!currentResult) return;

    try {
      const reportData = JSON.stringify(currentResult, null, 2);
      await navigator.clipboard.writeText(reportData);
      // You could show a toast notification here
      alert('Отчет скопирован в буфер обмена');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка экспорта');
    }
  };

  const displayResult = currentResult || (selectedHistoryId 
    ? history.find(h => h.id === selectedHistoryId)?.result 
    : null);

  return (
    <div className="deep-analysis-page">
      {/* Header */}
      <div className="da-header">
        <div className="da-header-content">
          <div className="da-title">
            <FiCpu className="da-title-icon" />
            <div>
              <h1>Глубокий анализ</h1>
              <p>YARA • Import Table • Packer Detection • String Signatures</p>
            </div>
          </div>
        </div>
      </div>

      <div className="da-content">
        {/* Left Panel - File Selection & History */}
        <div className="da-sidebar">
          {/* File Selection */}
          <div className="da-section">
            <h3>Файл для анализа</h3>
            <div className="da-file-selector">
              <Button
                variant="secondary"
                icon={<HiDocumentText />}
                onClick={handleSelectFile}
                disabled={isAnalyzing}
              >
                Выбрать файл
              </Button>
              
              {selectedFile && (
                <div className="da-selected-file">
                  <FiFileText />
                  <span title={selectedFile}>
                    {selectedFile.split(/[/\\]/).pop()}
                  </span>
                </div>
              )}
            </div>
            
            <Button
              variant="primary"
              icon={isAnalyzing ? <HiRefresh className="spinning" /> : <FiZap />}
              onClick={handleAnalyze}
              disabled={!selectedFile || isAnalyzing}
              className="da-analyze-btn"
            >
              {isAnalyzing ? (
                <>
                  {analysisProgress.message || 'Анализируем...'}
                  {analysisProgress.progress > 0 && (
                    <span style={{ marginLeft: '4px', opacity: 0.7 }}>
                      {analysisProgress.progress}%
                    </span>
                  )}
                </>
              ) : 'Начать анализ'}
            </Button>
            
            {error && (
              <div className="da-error">
                <FiAlertTriangle />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* History */}
          {history.length > 0 && (
            <div className="da-section">
              <h3>История анализа</h3>
              <div className="da-history">
                {history.map(item => (
                  <button
                    key={item.id}
                    className={`da-history-item ${selectedHistoryId === item.id ? 'active' : ''}`}
                    onClick={() => handleLoadHistory(item)}
                  >
                    <div className="da-history-icon">
                      {item.result.deepRiskScore >= 75 ? (
                        <HiXCircle className="risk-critical" />
                      ) : item.result.deepRiskScore >= 50 ? (
                        <HiExclamation className="risk-high" />
                      ) : (
                        <HiCheckCircle className="risk-low" />
                      )}
                    </div>
                    <div className="da-history-info">
                      <div className="da-history-name">{item.fileName}</div>
                      <div className="da-history-time">
                        {new Date(item.timestamp).toLocaleTimeString('ru-RU', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                    <div className="da-history-score">{item.result.deepRiskScore}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Results */}
        <div className="da-main">
          {!displayResult ? (
            <div className="da-empty">
              <FiSearch className="da-empty-icon" />
              <h2>Выберите файл для анализа</h2>
              <p>Глубокий анализ использует YARA-правила, анализ импортов, детекцию упаковщиков и строковые сигнатуры</p>
            </div>
          ) : (
            <motion.div
              className="da-results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {/* Risk Score Card */}
              <div className="da-score-card">
                <div className={`da-score-circle risk-${
                  displayResult.deepRiskScore >= 75 ? 'critical' :
                  displayResult.deepRiskScore >= 50 ? 'high' :
                  displayResult.deepRiskScore >= 25 ? 'medium' : 'low'
                }`}>
                  <div className="da-score-value">{displayResult.deepRiskScore}</div>
                  <div className="da-score-label">Risk Score</div>
                </div>
                <div className="da-score-details">
                  <h3>{displayResult.deepAssessment}</h3>
                  
                  {/* Large file warning */}
                  {(displayResult as any).analysisNote && (
                    <div className="da-warning-note" style={{
                      padding: '8px 12px',
                      marginTop: '12px',
                      background: 'rgba(255, 193, 7, 0.1)',
                      border: '1px solid rgba(255, 193, 7, 0.3)',
                      borderRadius: '6px',
                      fontSize: '13px',
                      color: '#ffb300'
                    }}>
                      {(displayResult as any).analysisNote}
                    </div>
                  )}
                  
                  <div className="da-score-stats">
                    <div className="da-stat">
                      <span>YARA</span>
                      <strong>{displayResult.yaraMatches?.length || 0}</strong>
                    </div>
                    {displayResult.importAnalysis && (
                      <div className="da-stat">
                        <span>APIs</span>
                        <strong>{displayResult.importAnalysis.suspiciousApis?.length || 0}</strong>
                      </div>
                    )}
                    {displayResult.packerDetection?.isPacked && (
                      <div className="da-stat">
                        <span>Packers</span>
                        <strong>{displayResult.packerDetection.packers?.length || 0}</strong>
                      </div>
                    )}
                    {displayResult.stringSignatures && (
                      <div className="da-stat">
                        <span>Strings</span>
                        <strong>{displayResult.stringSignatures.suspiciousStrings?.length || 0}</strong>
                      </div>
                    )}
                  </div>
                  {displayResult.analysisDuration && (
                    <div className="da-duration">
                      Анализ: {(displayResult.analysisDuration / 1000).toFixed(2)}с
                    </div>
                  )}
                </div>
              </div>

              {/* YARA Matches */}
              {displayResult.yaraMatches && displayResult.yaraMatches.length > 0 && (
                <div className="da-result-section">
                  <div className="da-section-header">
                    <h3>
                      <FiZap /> YARA Rules ({displayResult.yaraMatches?.length || 0})
                    </h3>
                  </div>
                  <div className="da-items-grid">
                    {displayResult.yaraMatches?.map((match, i) => (
                      <div key={i} className="da-yara-card">
                        <div className="da-card-header">
                          <strong>{match.name}</strong>
                          <div className="da-tags">
                            {match.tags?.map((tag, j) => (
                              <span key={j} className="da-tag">{tag}</span>
                            ))}
                          </div>
                        </div>
                        <p>{match.description}</p>
                        <div className="da-card-meta">
                          {match.matches?.length || 0} совпадений
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Import Analysis */}
              {displayResult.importAnalysis && (displayResult.importAnalysis.suspiciousApis?.length || 0) > 0 && (
                <div className="da-result-section">
                  <div className="da-section-header">
                    <h3>
                      <FiCode /> Import Table Analysis ({displayResult.importAnalysis.suspiciousApis?.length || 0})
                    </h3>
                    {(displayResult.importAnalysis.maliciousPatterns?.length || 0) > 0 && (
                      <span className="da-badge-danger">
                        {displayResult.importAnalysis.maliciousPatterns?.length || 0} malicious patterns
                      </span>
                    )}
                  </div>
                  
                  {(displayResult.importAnalysis.maliciousPatterns?.length || 0) > 0 && (
                    <div className="da-patterns">
                      {displayResult.importAnalysis.maliciousPatterns?.map((pattern, i) => (
                        <div key={i} className="da-pattern-card">
                          <div className="da-pattern-header">
                            <strong>{pattern.name}</strong>
                            <span className="da-confidence">{pattern.confidence}%</span>
                          </div>
                          <p>{pattern.description}</p>
                          <div className="da-pattern-apis">
                            {pattern.matchedApis?.slice(0, 5).map((api, j) => (
                              <code key={j}>{api}</code>
                            ))}
                            {(pattern.matchedApis?.length || 0) > 5 && (
                              <span>+{(pattern.matchedApis?.length || 0) - 5} more</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  <div className="da-api-list">
                    {displayResult.importAnalysis.suspiciousApis?.slice(0, 20).map((api, i) => (
                      <div key={i} className={`da-api-item risk-${api.riskLevel}`}>
                        <code>{api.dll}::{api.function}</code>
                        <span className="da-api-desc">{api.description}</span>
                        <span className={`da-api-risk risk-${api.riskLevel}`}>
                          {api.riskLevel}
                        </span>
                      </div>
                    ))}
                    {(displayResult.importAnalysis.suspiciousApis?.length || 0) > 20 && (
                      <div className="da-show-more">
                        +{(displayResult.importAnalysis.suspiciousApis?.length || 0) - 20} more APIs
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Packer Detection */}
              {displayResult.packerDetection?.isPacked && (
                <div className="da-result-section">
                  <div className="da-section-header">
                    <h3>
                      <FiPackage /> Packer Detection
                    </h3>
                  </div>
                  <div className="da-packer-grid">
                    {displayResult.packerDetection.packers?.map((packer, i) => (
                      <div key={i} className="da-packer-card">
                        <div className="da-packer-name">{packer.name}</div>
                        {packer.version && <div className="da-packer-version">v{packer.version}</div>}
                        <div className="da-packer-conf">{packer.confidence}% confidence</div>
                      </div>
                    ))}
                  </div>
                  {(displayResult.packerDetection.sectionAnomalies?.length || 0) > 0 && (
                    <div className="da-anomalies">
                      <strong>Section Anomalies:</strong>
                      {displayResult.packerDetection.sectionAnomalies?.map((anomaly, i) => (
                        <span key={i} className="da-anomaly-badge">{anomaly}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* String Signatures */}
              {displayResult.stringSignatures && (displayResult.stringSignatures.suspiciousStrings?.length || 0) > 0 && (
                <div className="da-result-section">
                  <div className="da-section-header">
                    <h3>
                      <FiFileText /> String Signatures ({displayResult.stringSignatures.suspiciousStrings?.length || 0})
                    </h3>
                  </div>
                  <div className="da-string-categories">
                    {displayResult.stringSignatures.categorySummary
                      ?.filter(c => c.count > 0)
                      .map((cat, i) => (
                        <span key={i} className="da-category-badge">
                          {cat.category}: {cat.count}
                        </span>
                      ))
                    }
                  </div>
                  <div className="da-string-list">
                    {displayResult.stringSignatures.suspiciousStrings?.slice(0, 15).map((str, i) => (
                      <div key={i} className={`da-string-item risk-${str.riskLevel}`}>
                        <code>{str.value.length > 80 ? str.value.slice(0, 80) + '...' : str.value}</code>
                        <div className="da-string-meta">
                          <span className="da-string-cat">{str.category}</span>
                          <span className="da-string-desc">{str.description}</span>
                        </div>
                      </div>
                    ))}
                    {(displayResult.stringSignatures.suspiciousStrings?.length || 0) > 15 && (
                      <div className="da-show-more">
                        +{(displayResult.stringSignatures.suspiciousStrings?.length || 0) - 15} more strings
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Export Button */}
              <div className="da-actions">
                <Button
                  variant="secondary"
                  icon={<HiDownload />}
                  onClick={handleExportReport}
                >
                  Копировать отчет
                </Button>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeepAnalysisPage;
