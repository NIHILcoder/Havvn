/**
 * File Tree Selector Component
 * 
 * Shows a tree view of files with checkboxes to include/exclude files from torrent.
 */

import React, { useState, useMemo } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './FileTreeSelector.css';
import { SelectionCheckbox } from './SelectionCheckbox';

export interface FileNode {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  children?: FileNode[];
}

interface FileTreeSelectorProps {
  files: FileNode[];
  excludedPaths: Set<string>;
  onToggle: (path: string, isDirectory: boolean) => void;
  onToggleAll: (included: boolean) => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface TreeNodeProps {
  node: FileNode;
  level: number;
  excludedPaths: Set<string>;
  onToggle: (path: string, isDirectory: boolean) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({ node, level, excludedPaths, onToggle }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const isExcluded = excludedPaths.has(node.path);
  
  // Check if any children are excluded
  const hasExcludedChildren = useMemo(() => {
    if (!node.children) return false;
    const checkChildren = (children: FileNode[]): boolean => {
      return children.some(child => {
        if (excludedPaths.has(child.path)) return true;
        if (child.children) return checkChildren(child.children);
        return false;
      });
    };
    return checkChildren(node.children);
  }, [node.children, excludedPaths]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node.path, node.isDirectory);
  };

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.isDirectory && node.children) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div className="tree-node">
      <div 
        className={`tree-node-content ${isExcluded ? 'excluded' : ''}`}
        style={{ paddingLeft: `${level * 20}px` }}
      >
        {node.isDirectory && node.children && (
          <button 
            className={`expand-btn ${isExpanded ? 'expanded' : ''}`}
            onClick={handleExpand}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        )}
        
        <label className="node-checkbox-label" onClick={(e) => e.stopPropagation()}>
          <SelectionCheckbox
            aria-label={node.name}
            indeterminate={!isExcluded && hasExcludedChildren}
            checked={!isExcluded}
            onChange={(e) => {
              e.stopPropagation();
              onToggle(node.path, node.isDirectory);
            }}
          />
        </label>

        <div className="node-icon">
          <Icon 
            name={node.isDirectory ? (isExpanded ? 'folder-open' : 'folder') : 'file'} 
            size={16} 
          />
        </div>

        <div className="node-info">
          <span className="node-name" title={node.name}>
            {node.name}
          </span>
          {!node.isDirectory && (
            <span className="node-size">{formatBytes(node.size)}</span>
          )}
          {node.isDirectory && hasExcludedChildren && !isExcluded && (
            <span className="partial-indicator" title={t('create.someFilesExcluded')}>
              <Icon name="minus-circle" size={12} />
            </span>
          )}
        </div>
      </div>

      {node.isDirectory && node.children && isExpanded && (
        <div className="tree-node-children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              excludedPaths={excludedPaths}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTreeSelector: React.FC<FileTreeSelectorProps> = ({
  files,
  excludedPaths,
  onToggle,
  onToggleAll,
}) => {
  const { t } = useTranslation();
  const stats = useMemo(() => {
    const countFiles = (nodes: FileNode[]): { total: number; excluded: number; totalSize: number; excludedSize: number } => {
      let total = 0;
      let excluded = 0;
      let totalSize = 0;
      let excludedSize = 0;

      for (const node of nodes) {
        if (node.isDirectory && node.children) {
          const childStats = countFiles(node.children);
          total += childStats.total;
          excluded += childStats.excluded;
          totalSize += childStats.totalSize;
          excludedSize += childStats.excludedSize;
        } else {
          total++;
          totalSize += node.size;
          if (excludedPaths.has(node.path)) {
            excluded++;
            excludedSize += node.size;
          }
        }
      }

      return { total, excluded, totalSize, excludedSize };
    };

    return countFiles(files);
  }, [files, excludedPaths]);

  const allIncluded = stats.excluded === 0;
  const includedCount = stats.total - stats.excluded;
  const includedSize = stats.totalSize - stats.excludedSize;

  return (
    <div className="file-tree-selector">
      <div className="tree-header">
        <label className="tree-header-checkbox">
          <SelectionCheckbox
            aria-label={t('create.allFilesSelected')}
            indeterminate={!allIncluded && includedCount > 0}
            checked={allIncluded}
            onChange={(e) => onToggleAll(e.target.checked)}
          />
          <span className="checkbox-mark"></span>
          <span className="header-label">
            {allIncluded ? t('create.allFilesSelected') : `${includedCount} ${t('filePicker.of')} ${stats.total} ${t('create.filesSelected')}`}
          </span>
        </label>
        
        <div className="tree-stats">
          <span className="stat-item">
            <Icon name="file" size={12} />
            {includedCount} / {stats.total}
          </span>
          <span className="stat-divider">•</span>
          <span className="stat-item">
            <Icon name="hard-drive" size={12} />
            {formatBytes(includedSize)}
            {stats.excludedSize > 0 && (
              <span className="excluded-size"> (-{formatBytes(stats.excludedSize)})</span>
            )}
          </span>
        </div>
      </div>

      <div className="tree-content">
        {files.map((file) => (
          <TreeNode
            key={file.path}
            node={file}
            level={0}
            excludedPaths={excludedPaths}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
};

export default FileTreeSelector;
