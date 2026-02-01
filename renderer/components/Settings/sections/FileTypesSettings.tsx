/**
 * FileTypesSettings Section
 * Configure which file types to scan
 */

import React from 'react';
import { useFormContext, Controller, useFieldArray } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { FiPlus, FiX } from 'react-icons/fi';
import { Button } from '../../Button';

export const FileTypesSettings: React.FC = () => {
  const { control, register, formState: { errors } } = useFormContext<VirusHuntSettings>();
  
  const customExtensions = useFieldArray({
    control,
    name: 'fileTypes.customExtensions' as any,
  });

  const exclusionList = useFieldArray({
    control,
    name: 'fileTypes.exclusionList' as any,
  });

  const [newExtension, setNewExtension] = React.useState('');
  const [newExclusion, setNewExclusion] = React.useState('');

  const handleAddExtension = () => {
    const ext = newExtension.trim();
    if (ext && ext.startsWith('.')) {
      (customExtensions.append as any)(ext);
      setNewExtension('');
    }
  };

  const handleAddExclusion = () => {
    const ext = newExclusion.trim();
    if (ext && ext.startsWith('.')) {
      (exclusionList.append as any)(ext);
      setNewExclusion('');
    }
  };

  return (
    <div className="settings-section">
      <h3 className="section-title">File Type Scanning</h3>
      <p className="section-description">
        Select which file types to scan for malware. Some file types are more likely to contain threats than others.
      </p>

      {/* Standard file types */}
      <div className="form-group">
        <label className="form-label">Standard file types</label>
        <div className="checkbox-grid">
          <label className="checkbox-item">
            <input
              type="checkbox"
              {...register('fileTypes.executable')}
            />
            <span className="checkbox-label">Executables (.exe, .dll, .sys)</span>
          </label>

          <label className="checkbox-item">
            <input
              type="checkbox"
              {...register('fileTypes.archive')}
            />
            <span className="checkbox-label">Archives (.zip, .rar, .7z)</span>
          </label>

          <label className="checkbox-item">
            <input
              type="checkbox"
              {...register('fileTypes.script')}
            />
            <span className="checkbox-label">Scripts (.bat, .cmd, .ps1)</span>
          </label>

          <label className="checkbox-item">
            <input
              type="checkbox"
              {...register('fileTypes.document')}
            />
            <span className="checkbox-label">Documents (.pdf, .doc, .xls)</span>
          </label>

          <label className="checkbox-item">
            <input
              type="checkbox"
              {...register('fileTypes.media')}
            />
            <span className="checkbox-label">Media (.mp4, .mkv, .mp3)</span>
          </label>
        </div>
        <p className="form-description">
          <strong>Recommended:</strong> Enable all except Media for balanced protection. Media files rarely contain executable threats.
        </p>
      </div>

      {/* Custom extensions */}
      <div className="form-group">
        <label className="form-label">Custom extensions to scan</label>
        <div className="tag-input-container">
          <div className="tag-list">
            {customExtensions.fields.map((field, index) => (
              <div key={field.id || index} className="tag-item">
                <span>{field as any}</span>
                <button
                  type="button"
                  onClick={() => customExtensions.remove(index)}
                  className="tag-remove"
                >
                  <FiX />
                </button>
              </div>
            ))}
          </div>
          <div className="tag-input-row">
            <input
              type="text"
              className="form-control"
              placeholder=".xyz (must start with dot)"
              value={newExtension}
              onChange={(e) => setNewExtension(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddExtension();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={handleAddExtension}
              disabled={!newExtension.trim() || !newExtension.startsWith('.')}
              icon={<FiPlus />}
            >
              Add
            </Button>
          </div>
        </div>
        <p className="form-description">
          Add custom file extensions to scan. Extensions must start with a dot (e.g., .xyz).
        </p>
        {errors.fileTypes?.customExtensions && (
          <p className="form-error">{errors.fileTypes.customExtensions.message}</p>
        )}
      </div>

      {/* Exclusion list */}
      <div className="form-group">
        <label className="form-label">Extension exclusion list</label>
        <div className="tag-input-container">
          <div className="tag-list">
            {exclusionList.fields.map((field, index) => (
              <div key={field.id || index} className="tag-item tag-item-danger">
                <span>{field as any}</span>
                <button
                  type="button"
                  onClick={() => exclusionList.remove(index)}
                  className="tag-remove"
                >
                  <FiX />
                </button>
              </div>
            ))}
          </div>
          <div className="tag-input-row">
            <input
              type="text"
              className="form-control"
              placeholder=".abc (must start with dot)"
              value={newExclusion}
              onChange={(e) => setNewExclusion(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddExclusion();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={handleAddExclusion}
              disabled={!newExclusion.trim() || !newExclusion.startsWith('.')}
              icon={<FiPlus />}
            >
              Add
            </Button>
          </div>
        </div>
        <p className="form-description">
          Extensions in this list will never be scanned, even if they match other criteria. Use with caution.
        </p>
        {errors.fileTypes?.exclusionList && (
          <p className="form-error">{errors.fileTypes.exclusionList.message}</p>
        )}
      </div>

      <style>{`
        .tag-input-container {
          border: 1px solid var(--border-color);
          border-radius: 6px;
          padding: 0.75rem;
          background: var(--bg-secondary);
        }

        .tag-list {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 0.75rem;
          min-height: 32px;
        }

        .tag-list:empty {
          margin-bottom: 0;
        }

        .tag-item {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.625rem;
          background: var(--accent-primary);
          color: white;
          border-radius: 4px;
          font-size: 0.8125rem;
          font-weight: 500;
        }

        .tag-item-danger {
          background: #ef4444;
        }

        .tag-remove {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          background: rgba(255, 255, 255, 0.2);
          border: none;
          border-radius: 50%;
          cursor: pointer;
          transition: background 0.2s;
          padding: 0;
        }

        .tag-remove:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .tag-remove svg {
          width: 10px;
          height: 10px;
        }

        .tag-input-row {
          display: flex;
          gap: 0.5rem;
        }

        .tag-input-row .form-control {
          flex: 1;
        }
      `}</style>
    </div>
  );
};
