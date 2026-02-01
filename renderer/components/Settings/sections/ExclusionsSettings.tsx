/**
 * ExclusionsSettings Section
 */

import React from 'react';
import { useFormContext, Controller, useFieldArray } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import { Button } from '../../Button';
import { FiPlus, FiTrash2, FiFolder, FiFile } from 'react-icons/fi';

export const ExclusionsSettings: React.FC = () => {
  const { control, register } = useFormContext<VirusHuntSettings>();
  
  const paths = useFieldArray({ control, name: 'exclusions.paths' });
  const hashes = useFieldArray({ control, name: 'exclusions.hashes' as any });
  const releaseGroups = useFieldArray({ control, name: 'exclusions.releaseGroups' as any });

  return (
    <div className="settings-section">
      <h3 className="section-title">Exclusions</h3>
      <p className="section-description">
        Exclude trusted paths, files, and release groups from scanning.
      </p>

      {/* Path exclusions */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Excluded paths</label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => (paths.append as any)({
              id: crypto.randomUUID(),
              path: '',
              type: 'folder',
              reason: '',
              addedAt: Date.now(),
            })}
            icon={<FiPlus />}
          >
            Add Path
          </Button>
        </div>

        <div className="exclusions-list">
          {paths.fields.map((field, index) => (
            <div key={field.id} className="exclusion-item">
              <div className="exclusion-header">
                <select className="exclusion-type" {...register(`exclusions.paths.${index}.type`)}>
                  <option value="file">File</option>
                  <option value="folder">Folder</option>
                </select>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => paths.remove(index)}
                  icon={<FiTrash2 />}
                />
              </div>
              <input
                type="text"
                className="form-control"
                placeholder="C:\Path\To\Exclude"
                {...register(`exclusions.paths.${index}.path`)}
              />
              <input
                type="text"
                className="form-control"
                placeholder="Reason (optional)"
                {...register(`exclusions.paths.${index}.reason`)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Hash exclusions */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Excluded hashes (SHA256)</label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => (hashes.append as any)('')}
            icon={<FiPlus />}
          >
            Add Hash
          </Button>
        </div>

        <div className="exclusions-list">
          {hashes.fields.map((field, index) => (
            <div key={field.id} className="exclusion-item-inline">
              <input
                type="text"
                className="form-control"
                placeholder="64-character SHA256 hash"
                maxLength={64}
                {...register(`exclusions.hashes.${index}` as const)}
              />
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => hashes.remove(index)}
                icon={<FiTrash2 />}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Release groups */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Trusted release groups</label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => (releaseGroups.append as any)('')}
            icon={<FiPlus />}
          >
            Add Group
          </Button>
        </div>

        <div className="exclusions-list">
          {releaseGroups.fields.map((field, index) => (
            <div key={field.id} className="exclusion-item-inline">
              <input
                type="text"
                className="form-control"
                placeholder="Release group name"
                {...register(`exclusions.releaseGroups.${index}` as const)}
              />
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => releaseGroups.remove(index)}
                icon={<FiTrash2 />}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Auto-add trusted groups */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Auto-add trusted groups</label>
          <Controller
            name="exclusions.autoAddTrustedGroups"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
        <p className="form-description">
          Automatically add release groups from files marked as safe to the trusted list.
        </p>
      </div>

      <style>{`
        .exclusions-list {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-top: 0.75rem;
        }

        .exclusion-item {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.75rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
        }

        .exclusion-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .exclusion-type {
          padding: 0.375rem 0.625rem;
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          color: var(--text-primary);
          font-size: 0.875rem;
        }

        .exclusion-item-inline {
          display: flex;
          gap: 0.5rem;
          align-items: center;
        }

        .exclusion-item-inline .form-control {
          flex: 1;
        }
      `}</style>
    </div>
  );
};
