import { describe, it, expect } from 'vitest';
import {
  PLAYER_AUDIO_FRAME, PLAYER_VIDEO_FRAME, PLAYER_ROOM_FRAME, PLAYER_FRAME_NAMES,
  playerFrameName, isPlayerFrame,
} from './player-windows';
import { POPOUT_FRAME_PREFIX, isPopoutFrameName, isDockWindowFrame } from './dock-windows';

describe('the detached player windows', () => {
  it('gives audio and video separate frames, so each remembers its own size', () => {
    // One shared name would reopen the compact audio bar at the last film's size.
    expect(playerFrameName('audio')).toBe(PLAYER_AUDIO_FRAME);
    expect(playerFrameName('video')).toBe(PLAYER_VIDEO_FRAME);
    expect(PLAYER_AUDIO_FRAME).not.toBe(PLAYER_VIDEO_FRAME);
  });

  it('sends anything it cannot classify to the video window', () => {
    // A 420×150 bar is the wrong shape to discover that a file has pictures in it.
    for (const k of ['image', 'unknown', '', null, undefined]) {
      expect(playerFrameName(k)).toBe(PLAYER_VIDEO_FRAME);
    }
  });

  it('keeps both names under the pop-out prefix the window handler gates on', () => {
    for (const n of PLAYER_FRAME_NAMES) {
      expect(n.startsWith(POPOUT_FRAME_PREFIX)).toBe(true);
      expect(isPopoutFrameName(n)).toBe(true);
    }
  });

  it('gives the room stage a frame of its own, so two players cannot collide', () => {
    // window.open with an existing frame name returns THAT window: a shared name
    // would portal the room player into the downloads player's document.
    expect(PLAYER_ROOM_FRAME).not.toBe(PLAYER_VIDEO_FRAME);
    expect(PLAYER_ROOM_FRAME).not.toBe(PLAYER_AUDIO_FRAME);
    expect(new Set(PLAYER_FRAME_NAMES).size).toBe(PLAYER_FRAME_NAMES.length);
    expect(isPlayerFrame(PLAYER_ROOM_FRAME)).toBe(true);
  });

  it('is never mistaken for a dock slot', () => {
    // The dock's pool invariant counts panels; a player window is not one, which
    // is the whole reason it is a feature window rather than a seventh panel.
    for (const n of PLAYER_FRAME_NAMES) expect(isDockWindowFrame(n)).toBe(false);
    expect(isPlayerFrame('havvn-dock-1')).toBe(false);
    expect(isPlayerFrame(PLAYER_AUDIO_FRAME)).toBe(true);
  });
});
