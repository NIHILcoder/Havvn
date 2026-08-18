/**
 * The player's detached windows — the ONE place their frame names are written.
 *
 * `shared/**` is compiled by both tsconfigs, so the main-process allowlist
 * (electron/main.ts `POPOUTS`) and the renderer's `usePopout` call read the same
 * strings. Drift between them fails in a way that is easy to misread: the window
 * simply never opens, because `setWindowOpenHandler` denies a frame name it does
 * not know.
 *
 * TWO NAMES, NOT ONE, and the reason is geometry. Window bounds are persisted per
 * frame name, so a single shared name would reopen the compact audio player at
 * the size of the last film — or the film at the size of the audio bar. They are
 * one feature with two shapes, and each shape has to remember its own.
 *
 * No Node/Electron/DOM imports — pure data, so vitest runs it directly.
 */

/** Media the detached player can hold. Mirrors shared/media.ts's classification
 *  at the granularity the WINDOW cares about: everything visual is 'video'. */
export type PlayerWindowKind = 'audio' | 'video';

export const PLAYER_VIDEO_FRAME = 'havvn-player-video';
export const PLAYER_AUDIO_FRAME = 'havvn-player-audio';
/**
 * The room's stage player, which is a THIRD name rather than a reuse of the two
 * above. Sharing one would be a bug, not a saving: `window.open` with an existing
 * frame name returns THAT window, so a detached download and a detached room
 * player would fight over one child — the second portal would land in the first's
 * document and one of them would go dark. Audio and video share this frame because
 * the room stage is the same shape either way: the visualiser, the watchers strip
 * and the reaction bar are all still there when it is music.
 */
export const PLAYER_ROOM_FRAME = 'havvn-player-room';

/** Every name, for the main-process allowlist. */
export const PLAYER_FRAME_NAMES: readonly string[] = [PLAYER_VIDEO_FRAME, PLAYER_AUDIO_FRAME, PLAYER_ROOM_FRAME];

/**
 * The frame a given media kind detaches into. Anything that is not audio gets the
 * video window — an unknown kind is far more likely to be something with pictures,
 * and a 420×150 bar is the wrong shape to discover that in.
 */
export function playerFrameName(kind: string | null | undefined): string {
  return kind === 'audio' ? PLAYER_AUDIO_FRAME : PLAYER_VIDEO_FRAME;
}

/** True for either player window (main uses it to skip the dock's slot logic). */
export function isPlayerFrame(name: string): boolean {
  return PLAYER_FRAME_NAMES.includes(name);
}
