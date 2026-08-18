/**
 * Category picker.
 *
 * Categories have existed in the store since the beginning (id, name, icon,
 * colour) and a download's category is rendered on its row, but nothing in the
 * UI could ever set one — so `download.category` was null for everybody. This is
 * the control that makes them reachable, shared by the places that add a
 * download: search results and RSS feeds.
 */

import React from 'react';
import { Select } from './Select';
import { useCategories } from '../utils/useCategories';
import { useTranslation } from '../utils/i18nContext';

interface CategorySelectProps {
  /** Selected category id; '' means "no category". */
  value: string;
  onChange: (categoryId: string) => void;
  className?: string;
  disabled?: boolean;
}

export const CategorySelect: React.FC<CategorySelectProps> = ({
  value,
  onChange,
  className = '',
  disabled = false,
}) => {
  const { t } = useTranslation();
  const categories = useCategories();

  const options = [
    { value: '', label: t('category.none'), icon: 'folder' },
    ...categories.map(c => ({ value: c.id, label: c.name, icon: c.icon })),
  ];

  return (
    <Select
      options={options}
      value={value}
      onChange={onChange}
      className={className}
      disabled={disabled}
      placeholder={t('category.none')}
    />
  );
};
