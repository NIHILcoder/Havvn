import { ErrorMessage } from '../../../components/ErrorMessage';
import React, { useState } from 'react';
import { Button, Icon, Select, Toggle } from '../../../components';
import { SettingRow } from '../controls';
import { useTranslation } from '../../../utils/i18nContext';
import { navigation, useNavigation } from '../../../utils/navigation';
import { useDownloadViews } from '../../../utils/download-views';
import { commandFavorite } from '../../../commands/navigationCommands';
import type { Command } from '../../../commands/registry';
import { FAVORITES_LIMIT, NAVIGATION_PAGES, NavigationError, favoriteCommandId, favoriteKey } from '../../../../shared/navigation';
import './NavigationPanel.css';

export const NavigationPanel: React.FC<{ getCommands?: () => readonly Command[] }> = ({ getCommands = () => [] }) => {
  const { t } = useTranslation(), { preferences, error: unreadable } = useNavigation();
  // Candidate names/availability follow saved-view changes, including other windows.
  useDownloadViews();
  const [selection, setSelection] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const commands = getCommands(), index = new Map(commands.map(command => [command.id, command]));
  const existing = new Set(preferences.favorites.map(favoriteKey));
  const candidates = commands.flatMap(command => {
    const favorite = commandFavorite(command);
    return favorite && !existing.has(favoriteKey(favorite)) ? [{ command, favorite }] : [];
  });
  const attempt = (action: () => void, message = t('navigation.saved')) => {
    try { action(); setError(''); setNotice(message); return true; }
    catch (cause) { setNotice(''); setError(t(`navigation.error.${cause instanceof NavigationError ? cause.code : 'storage'}`)); return false; }
  };
  const moved = (action: () => void, element: HTMLElement | null) => {
    if (attempt(action, t('navigation.reordered')) && element) queueMicrotask(() => { if (element.isConnected) element.focus(); });
  };
  const controls = (label: string, position: number, length: number, move: (direction: -1 | 1, element: HTMLElement | null) => void) => <>
    <Button variant="secondary" size="sm" iconOnly icon={<Icon name="arrow-up" size={14} />} disabled={unreadable || position === 0}
      aria-label={`${t('navigation.up')}: ${label}`} title={`${t('navigation.up')}: ${label}`} onClick={event => move(-1, event.currentTarget.closest('li'))} />
    <Button variant="secondary" size="sm" iconOnly icon={<Icon name="arrow-down" size={14} />} disabled={unreadable || position === length - 1}
      aria-label={`${t('navigation.down')}: ${label}`} title={`${t('navigation.down')}: ${label}`} onClick={event => move(1, event.currentTarget.closest('li'))} />
  </>;
  return <>
    {unreadable && <p role="alert">{t('navigation.storageHint')}</p>}
    <p className="navigation-help">{t('navigation.fixed')}</p>
    <p id="navigation-reorder-help" className="navigation-help">{t('navigation.keyboardHint')}</p>
    <ol className="navigation-editor-list" aria-label={t('navigation.utilities')}>
      {preferences.utilities.map((item, position) => {
        const page = NAVIGATION_PAGES.find(page => page.id === item.id)!, label = t(page.labelKey);
        const move = (direction: -1 | 1, element: HTMLElement | null) => moved(() => navigation.moveUtility(item.id, direction), element);
        return <li key={item.id} tabIndex={0} data-navigation-item={item.id} aria-label={label} aria-describedby="navigation-reorder-help"
          onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowUp' ? -1 : 1, event.currentTarget); } }}>
          <span className="navigation-item-name"><Icon name={page.icon} size={15} />{label}</span>
          <div className="navigation-item-controls">{controls(label, position, preferences.utilities.length, move)}
            <Toggle disabled={unreadable} ariaLabel={`${t('navigation.show')}: ${label}`} checked={item.visible} onChange={visible => { attempt(() => navigation.setVisible(item.id, visible)); }} />
          </div>
        </li>;
      })}
    </ol>
    <SettingRow label={t('history.title')} description={t('navigation.historyHint')} control={<Toggle disabled={unreadable} ariaLabel={`${t('navigation.show')}: ${t('history.title')}`}
      checked={preferences.showHistory} onChange={visible => { attempt(() => navigation.showHistory(visible)); }} />} />
    <Button variant="secondary" onClick={() => { attempt(() => navigation.resetMenu()); }}>{t('navigation.resetMenu')}</Button>
    <h4>{t('navigation.favorites')} · {preferences.favorites.length}/{FAVORITES_LIMIT}</h4>
    <p className="navigation-help">{t('navigation.favoritesHint')}</p>
    <div className="navigation-add">
      <Select ariaLabel={t('navigation.chooseFavorite')} disabled={unreadable || preferences.favorites.length >= FAVORITES_LIMIT} value={selection} onChange={setSelection}
        options={[{ value: '', label: t('navigation.chooseFavorite') }, ...candidates.map(({ command, favorite }) => ({ value: favoriteKey(favorite), label: `${t(`navigation.kind.${favorite.kind}`)} · ${command.title}` }))]} />
      <Button variant="primary" disabled={unreadable || !selection || preferences.favorites.length >= FAVORITES_LIMIT} icon={<Icon name="star" size={14} />} onClick={() => {
        if (attempt(() => {
          const live = getCommands().map(commandFavorite).find(favorite => favorite && favoriteKey(favorite) === selection);
          if (!live) throw new NavigationError('missing'); navigation.add(live);
        })) setSelection('');
      }}>{t('navigation.add')}</Button>
    </div>
    <ol className="navigation-editor-list" aria-label={t('navigation.favorites')}>
      {preferences.favorites.map((favorite, position) => {
        const key = favoriteKey(favorite), command = index.get(favoriteCommandId(favorite));
        const label = command?.title ?? `${t(`navigation.unavailable.${favorite.kind}`)} · ${favorite.id.slice(-8)}`;
        const reason = command?.disabledReason() ?? (!command ? t('commands.missing') : null);
        const move = (direction: -1 | 1, element: HTMLElement | null) => moved(() => navigation.moveFavorite(key, direction), element);
        return <li key={key} tabIndex={0} data-navigation-favorite={key} aria-label={label} aria-describedby="navigation-reorder-help"
          onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowUp' ? -1 : 1, event.currentTarget); } }}>
          <span className="navigation-item-name"><span>{label}<small>{reason || t(`navigation.kind.${favorite.kind}`)}</small></span></span>
          <div className="navigation-item-controls">{controls(label, position, preferences.favorites.length, move)}
            <Button variant="ghost" size="sm" disabled={unreadable} iconOnly icon={<Icon name="x" size={14} />} title={`${t('navigation.remove')}: ${label}`} aria-label={`${t('navigation.remove')}: ${label}`}
              onClick={() => { attempt(() => navigation.remove(key)); }} />
          </div>
        </li>;
      })}
    </ol>
    {!preferences.favorites.length && <p>{t('navigation.empty')}</p>}
    {error && <p role="alert"><ErrorMessage error={error} /></p>}<p className="navigation-help" role="status" aria-live="polite">{notice}</p>
  </>;
};
