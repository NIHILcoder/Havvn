/**
 * ScanResults Component
 * 
 * Virtualized table with filtering, sorting, and bulk actions
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HiCheckCircle,
  HiExclamation,
  HiXCircle,
  HiSearch,
  HiFilter,
  HiDownload,
  HiTrash,
  HiEye,
  HiChevronUp,
  HiChevronDown,
  HiX,
} from 'react-icons/hi';
import { FiLock, FiKey, FiAlertTriangle } from 'react-icons/fi';
import {
  useVirusHuntStore,
  getThreatColor,
  filterAndSortResults,
  scanResultToRow,
} from '../stores/virusHuntStore';
import {
  ScanResultRow,
  ColumnConfig,
  BulkAction,
  ExportFormat,
} from '../types/scan-results';
import { FileCategory } from '../../shared/virushunt-types';
import { Button } from './Button';
import { Input } from './Input';
import ScanResultModal from './ScanResultModal';
import './ScanResults.css';

const ScanResults: React.FC = () => {
  const {
    scanResultRows,
    resultFilters,
    updateResultFilters,
    resetResultFilters,
    resultSort,
    updateResultSort,
    selectedRowIds,
    toggleRowSelection,
    selectAllRows,
    clearSelection,
    deleteScanResultRows,
    exportResults,
  } = useVirusHuntStore();

  const [searchDebounced, setSearchDebounced] = useState(resultFilters.search);
  const [selectedRow, setSelectedRow] = useState<ScanResultRow | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const parentRef = React.useRef<HTMLDivElement>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      updateResultFilters({ search: searchDebounced });
    }, 300);

    return () => clearTimeout(timer);
  }, [searchDebounced, updateResultFilters]);

  // Filtered and sorted data
  const filteredRows = useMemo(() => {
    return filterAndSortResults(scanResultRows, resultFilters, resultSort);
  }, [scanResultRows, resultFilters, resultSort]);

  // Virtualizer
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 10,
  });

  // Column configuration
  const columns: ColumnConfig[] = [
    { id: 'fileName', header: 'Имя файла', width: 250, minWidth: 150, sortable: true, resizable: true },
    { id: 'directory', header: 'Путь', width: 300, minWidth: 200, sortable: true, resizable: true },
    { id: 'formattedSize', header: 'Размер', width: 100, minWidth: 80, sortable: true, resizable: false },
    { id: 'categoryLabel', header: 'Категория', width: 120, minWidth: 100, sortable: true, resizable: false },
    { id: 'riskScore', header: 'Риск', width: 80, minWidth: 60, sortable: true, resizable: false },
  ];

  // Export formats
  const exportFormats: ExportFormat[] = [
    { format: 'json', label: 'JSON', icon: <HiDownload /> },
    { format: 'csv', label: 'CSV', icon: <HiDownload /> },
    { format: 'txt', label: 'TXT', icon: <HiDownload /> },
    { format: 'html', label: 'HTML', icon: <HiDownload /> },
  ];

  // Bulk actions
  const bulkActions: BulkAction[] = [
    {
      id: 'delete',
      label: 'Удалить файлы',
      icon: <HiTrash />,
      variant: 'danger',
      confirm: true,
      confirmMessage: 'Вы уверены, что хотите удалить выбранные файлы? Это действие необратимо.',
      action: async (rows) => {
        setIsDeleting(true);
        try {
          await deleteScanResultRows(rows.map(r => r.id));
          clearSelection();
        } finally {
          setIsDeleting(false);
        }
      },
    },
    {
      id: 'whitelist',
      label: 'Добавить в исключения',
      icon: <HiCheckCircle />,
      variant: 'default',
      action: async (rows) => {
        for (const row of rows) {
          await window.api.virusHunt.addToWhitelist(row.hash, row.fileName, row.size);
        }
      },
    },
  ];

  // Handle row click
  const handleRowClick = useCallback((row: ScanResultRow) => {
    setSelectedRow(row);
    setIsModalOpen(true);
  }, []);

  // Handle sort
  const handleSort = useCallback((column: keyof ScanResultRow) => {
    updateResultSort({
      column,
      direction: resultSort.column === column && resultSort.direction === 'asc' ? 'desc' : 'asc',
    });
  }, [resultSort, updateResultSort]);

  // Handle select all
  const handleSelectAll = useCallback(() => {
    if (selectedRowIds.size === filteredRows.length) {
      clearSelection();
    } else {
      selectAllRows(filteredRows.map(r => r.id));
    }
  }, [selectedRowIds, filteredRows, clearSelection, selectAllRows]);

  // Handle bulk action
  const handleBulkAction = useCallback(async (action: BulkAction) => {
    const selectedRows = filteredRows.filter(row => selectedRowIds.has(row.id));
    
    if (action.confirm) {
      const confirmed = confirm(action.confirmMessage || 'Вы уверены?');
      if (!confirmed) return;
    }
    
    try {
      await action.action(selectedRows);
    } catch (error) {
      console.error('Bulk action failed:', error);
      alert('Не удалось выполнить действие');
    }
  }, [filteredRows, selectedRowIds]);

  // Handle export
  const handleExport = useCallback(async (format: ExportFormat['format']) => {
    try {
      const rowIds = selectedRowIds.size > 0 
        ? Array.from(selectedRowIds) 
        : undefined;
      
      await exportResults(format, rowIds);
    } catch (error) {
      console.error('Export failed:', error);
      alert('Не удалось экспортировать результаты');
    }
  }, [selectedRowIds, exportResults]);

  // Get status icon
  const getStatusIcon = (category: FileCategory) => {
    switch (category) {
      case 'safe':
        return <HiCheckCircle className="status-icon safe" />;
      case 'crack':
        return <FiLock className="status-icon crack" />;
      case 'keygen':
        return <FiKey className="status-icon keygen" />;
      case 'suspicious':
        return <FiAlertTriangle className="status-icon suspicious" />;
      case 'dangerous':
        return <HiXCircle className="status-icon dangerous" />;
      default:
        return <HiExclamation className="status-icon unknown" />;
    }
  };

  const selectedCount = selectedRowIds.size;
  const hasSelection = selectedCount > 0;

  return (
    <div className="scan-results-container">
      {/* Header */}
      <div className="scan-results-header">
        <div className="header-left">
          <h2>Результаты сканирования</h2>
          <span className="results-count">
            {filteredRows.length} {filteredRows.length === 1 ? 'файл' : 'файлов'}
          </span>
        </div>

        <div className="header-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<HiFilter />}
            onClick={() => setShowFilters(!showFilters)}
          >
            Фильтры
          </Button>
        </div>
      </div>

      {/* Filters */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            className="filters-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="filters-content">
              {/* Search */}
              <div className="filter-group">
                <label>Поиск</label>
                <div className="search-input-wrapper">
                  <HiSearch className="search-icon" />
                  <input
                    type="text"
                    placeholder="Поиск по имени или пути..."
                    value={searchDebounced}
                    onChange={(e) => setSearchDebounced(e.target.value)}
                    className="search-input"
                  />
                  {searchDebounced && (
                    <button
                      className="clear-search"
                      onClick={() => setSearchDebounced('')}
                    >
                      <HiX />
                    </button>
                  )}
                </div>
              </div>

              {/* Category filter */}
              <div className="filter-group">
                <label>Категории</label>
                <div className="category-filters">
                  {(['safe', 'crack', 'keygen', 'suspicious', 'dangerous', 'unknown'] as FileCategory[]).map(
                    (cat) => (
                      <label key={cat} className="category-checkbox">
                        <input
                          type="checkbox"
                          checked={resultFilters.categories.includes(cat)}
                          onChange={(e) => {
                            const newCategories = e.target.checked
                              ? [...resultFilters.categories, cat]
                              : resultFilters.categories.filter((c) => c !== cat);
                            updateResultFilters({ categories: newCategories });
                          }}
                        />
                        <span className="category-label" style={{ color: getThreatColor(cat) }}>
                          {cat}
                        </span>
                      </label>
                    )
                  )}
                </div>
              </div>

              {/* Risk score range */}
              <div className="filter-group">
                <label>Риск-скор: {resultFilters.riskScoreMin} - {resultFilters.riskScoreMax}</label>
                <div className="risk-range">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={resultFilters.riskScoreMin}
                    onChange={(e) =>
                      updateResultFilters({ riskScoreMin: parseInt(e.target.value) })
                    }
                  />
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={resultFilters.riskScoreMax}
                    onChange={(e) =>
                      updateResultFilters({ riskScoreMax: parseInt(e.target.value) })
                    }
                  />
                </div>
              </div>

              {/* Reset filters */}
              <Button variant="secondary" size="sm" onClick={resetResultFilters}>
                Сбросить фильтры
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk actions toolbar */}
      <AnimatePresence>
        {hasSelection && (
          <motion.div
            className="bulk-actions-toolbar"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="bulk-actions-content">
              <span className="selection-count">
                Выбрано: {selectedCount} {selectedCount === 1 ? 'файл' : 'файлов'}
              </span>

              <div className="bulk-actions-buttons">
                {bulkActions.map((action) => (
                  <Button
                    key={action.id}
                    variant={action.variant}
                    size="sm"
                    icon={action.icon}
                    onClick={() => handleBulkAction(action)}
                    disabled={isDeleting}
                  >
                    {action.label}
                  </Button>
                ))}

                <div className="export-dropdown">
                  <Button variant="secondary" size="sm" icon={<HiDownload />}>
                    Экспорт
                  </Button>
                  <div className="export-menu">
                    {exportFormats.map((format) => (
                      <button
                        key={format.format}
                        className="export-option"
                        onClick={() => handleExport(format.format)}
                      >
                        {format.icon}
                        {format.label}
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  icon={<HiX />}
                  onClick={clearSelection}
                >
                  Отменить выбор
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Table */}
      <div className="table-container">
        {/* Table header */}
        <div className="table-header">
          <div className="header-cell checkbox-cell">
            <input
              type="checkbox"
              checked={selectedRowIds.size === filteredRows.length && filteredRows.length > 0}
              onChange={handleSelectAll}
            />
          </div>

          <div className="header-cell status-cell">Статус</div>

          {columns.map((col) => (
            <div
              key={col.id}
              className={`header-cell ${col.sortable ? 'sortable' : ''}`}
              style={{ width: col.width, minWidth: col.minWidth }}
              onClick={() => col.sortable && handleSort(col.id)}
            >
              <span>{col.header}</span>
              {col.sortable && resultSort.column === col.id && (
                <span className="sort-indicator">
                  {resultSort.direction === 'asc' ? <HiChevronUp /> : <HiChevronDown />}
                </span>
              )}
            </div>
          ))}

          <div className="header-cell actions-cell">Действия</div>
        </div>

        {/* Virtualized rows */}
        <div ref={parentRef} className="table-body" style={{ height: '600px', overflow: 'auto' }}>
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = filteredRows[virtualRow.index];
              const isSelected = selectedRowIds.has(row.id);

              return (
                <div
                  key={row.id}
                  className={`table-row ${isSelected ? 'selected' : ''} row-${row.category}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="row-cell checkbox-cell">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRowSelection(row.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>

                  <div className="row-cell status-cell">
                    {getStatusIcon(row.category || FileCategory.UNKNOWN)}
                  </div>

                  <div
                    className="row-cell"
                    style={{ width: columns[0].width }}
                    onClick={() => handleRowClick(row)}
                  >
                    <span className="file-name" title={row.fileName}>
                      {row.fileName}
                    </span>
                  </div>

                  <div
                    className="row-cell"
                    style={{ width: columns[1].width }}
                    onClick={() => handleRowClick(row)}
                  >
                    <span className="file-path" title={row.directory}>
                      {row.directory}
                    </span>
                  </div>

                  <div
                    className="row-cell"
                    style={{ width: columns[2].width }}
                    onClick={() => handleRowClick(row)}
                  >
                    {row.formattedSize}
                  </div>

                  <div
                    className="row-cell"
                    style={{ width: columns[3].width }}
                    onClick={() => handleRowClick(row)}
                  >
                    <span className="category-badge" style={{ color: getThreatColor(row.category || FileCategory.UNKNOWN) }}>
                      {row.categoryLabel}
                    </span>
                  </div>

                  <div
                    className="row-cell"
                    style={{ width: columns[4].width }}
                    onClick={() => handleRowClick(row)}
                  >
                    <span className={`risk-score risk-${row.riskLevel}`}>
                      {row.riskScore}
                    </span>
                  </div>

                  <div className="row-cell actions-cell">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<HiEye />}
                      onClick={() => handleRowClick(row)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Empty state */}
        {filteredRows.length === 0 && (
          <div className="table-empty">
            <HiExclamation className="empty-icon" />
            <p>Нет результатов для отображения</p>
            {resultFilters.search || resultFilters.categories.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={resetResultFilters}>
                Сбросить фильтры
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selectedRow && (
        <ScanResultModal
          isOpen={isModalOpen}
          onClose={() => {
            setIsModalOpen(false);
            setSelectedRow(null);
          }}
          result={selectedRow}
        />
      )}
    </div>
  );
};

export default ScanResults;
