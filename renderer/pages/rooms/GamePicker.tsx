/**
 * GamePicker — the window that opens before a server is created: which game?
 *
 * It exists because the create form had no honest place for the answer. With one
 * registered module the form's game field was hidden entirely, so "add a server"
 * went straight to a Minecraft screen and the feature read as a Minecraft
 * feature. A row of tiles inside the form fixed the visibility and broke
 * something else — a game that does not work yet sat beside one that does, at
 * the same size, looking like an equal option.
 *
 * So: two sections with headings, not a row. "Available" holds what can actually
 * run; "Coming soon" holds intentions, visibly separated and non-interactive. A
 * heading does what a padlock alone cannot — it groups, and a group cannot be
 * mistaken for a peer.
 *
 * The planned games are DELIBERATELY NOT MODULES. Registering one in
 * electron/gameserver/modules/index.ts is what makes a module trust tier A and
 * lets it contribute code; nothing that cannot run a server belongs there. These
 * are copy — a name and a padlock — and plannedGamesFor drops any of them the
 * moment a real module registers under the same id, so shipping a game deletes
 * its own placeholder instead of leaving it beside the working thing.
 *
 * REALM: this panel can be torn off into a child window, so the overlay portals
 * to the OWNING document's body (useHostWindow) — `document.body` would draw it
 * in the window the user is not looking at. There is no element to read an
 * ownerDocument from, since the portal target is needed before anything mounts,
 * which is exactly what the context is for. Mirrors LanPeerPicker.
 */
import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import type { RoomServerState } from '../../../shared/gameserver-types';
import './RoomServerPanel.css';

/**
 * Games shown locked. Three, not a wishlist: every entry is a promise, and a
 * short list of them is worth more than a long one nobody can date. `id` is what
 * makes the list self-cleaning — see plannedGamesFor.
 */
const PLANNED_GAMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'terraria', label: 'Terraria' },
  { id: 'valheim', label: 'Valheim' },
  { id: 'factorio', label: 'Factorio' },
];

/** The planned games still worth showing: everything no registered module
 *  already covers. Pure, so the self-cleaning rule is testable without a DOM. */
export function plannedGamesFor(
  modules: ReadonlyArray<{ id: string }>,
  planned: ReadonlyArray<{ id: string; label: string }> = PLANNED_GAMES,
): Array<{ id: string; label: string }> {
  const shipped = new Set(modules.map((m) => m.id));
  return planned.filter((g) => !shipped.has(g.id));
}

export interface GamePickerProps {
  /** Registered modules — everything here can actually run a server. */
  modules: RoomServerState['modules'];
  onClose: () => void;
  /** Chosen module id; the create form opens on it. */
  onPick: (moduleId: string) => void;
}

export const GamePicker: React.FC<GamePickerProps> = ({ modules, onClose, onPick }) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  const planned = useMemo(() => plannedGamesFor(modules), [modules]);

  /**
   * A one-line "what this gives you" under a game's name, when the dictionary
   * has one. Missing keys come back as the key itself, so the comparison is what
   * keeps `rooms.server.gameDesc.terraria` off the screen the day someone adds
   * Terraria without writing the copy.
   */
  const describe = (moduleId: string): string | null => {
    const key = `rooms.server.gameDesc.${moduleId}`;
    // `as never` is this codebase's idiom for a key built at runtime (see the
    // server alerts and import failures). t() falls back to returning the key
    // itself, which is the comparison below.
    const text = t(key as never);
    return text && text !== key ? text : null;
  };

  return createPortal(
    <Modal onClose={onClose} title={t('rooms.server.pickGame')} icon="server" size="md" bodyClassName="gp-body">
      <div className="gp-section-label">{t('rooms.server.gameAvailable')}</div>
      {modules.length === 0 ? (
        <div className="gp-empty">{t('rooms.server.noGames')}</div>
      ) : (
        <div className="gp-list">
          {modules.map((m) => {
            const desc = describe(m.id);
            return (
              <button key={m.id} type="button" className="gp-row" onClick={() => onPick(m.id)}>
                <Icon name="server" size={17} />
                <span className="gp-row-text">
                  <span className="gp-row-name">{m.displayName}</span>
                  {desc && <span className="gp-row-desc">{desc}</span>}
                </span>
                <Icon name="chevron-right" size={15} />
              </button>
            );
          })}
        </div>
      )}

      {planned.length > 0 && (
        <>
          <div className="gp-section-label gp-section-soon">{t('rooms.server.comingSoon')}</div>
          <div className="gp-list">
            {planned.map((g) => (
              // A disabled button, not a styled div: "exists but unavailable" is
              // something the platform already announces, and the reason rides in
              // the title rather than being left to the padlock to imply.
              <button key={g.id} type="button" className="gp-row is-locked" disabled title={t('rooms.server.comingSoonHint')}>
                <Icon name="lock" size={17} />
                <span className="gp-row-text">
                  <span className="gp-row-name">{g.label}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>,
    host.document.body,
  );
};

export default GamePicker;
