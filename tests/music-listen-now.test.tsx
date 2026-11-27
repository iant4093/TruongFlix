import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));

import MusicLibrary from '../src/music/components/MusicLibrary';
import { assembleLibrary } from '../src/music/library';
import { openTab } from '../src/music/nav';
import { setMusicLibrary, useMusicPlayer } from '../src/music/player';
import type { MusicApi } from '../src/music/api';
import type { MusicPin, MusicPlaylist, MusicTrack } from '../src/music/types';

const track = (id: number, albumId: number, album: string): MusicTrack => ({
  id,
  title: `Song ${id}`,
  artist: 'Luma Vale',
  artistId: 1,
  album,
  albumId,
  albumArtist: 'Luma Vale',
  albumArtistId: 1,
  trackNo: id,
  discNo: 1,
  year: 2023,
  genre: 'Pop',
  duration: 100,
  codec: 'mp3',
  art: null,
  favourite: false,
  plays: 0,
  lastPlayed: null,
  addedAt: 1000,
  hasLyrics: false,
});

const tracks = [track(1, 1, 'Neon Harbour'), track(2, 2, 'Paper Satellites')];
const setPinned = vi.fn(async () => undefined);

function load(playlists: MusicPlaylist[], pins: MusicPin[]) {
  setMusicLibrary(assembleLibrary(tracks, playlists, pins));
}

const shelf = (title: string) => screen.queryByRole('heading', { name: title })?.closest('section') ?? null;

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  useMusicPlayer.setState({ api: { artUrl: () => null, setPinned } as unknown as MusicApi });
  openTab('listen');
});
afterEach(() => {
  cleanup();
  useMusicPlayer.setState({ library: null, byId: new Map(), api: null });
});

it('leaves out the Pinned and Playlists rows when nothing is pinned and there are no playlists', () => {
  load([], []);
  render(<MusicLibrary variant="desktop" />);
  expect(shelf('Recently Added')).not.toBeNull();
  expect(shelf('Pinned')).toBeNull();
  expect(shelf('Playlists')).toBeNull();
  expect(screen.queryByText(/pinned/i)).toBeNull();
});

it('shows pinned items first, in pinned order, and playlists newest first', () => {
  load(
    [
      { id: 7, name: 'Old Mix', trackIds: [1], updatedAt: 100 },
      { id: 8, name: 'New Mix', trackIds: [2], updatedAt: 900 },
    ],
    [
      { kind: 'album', id: 2 },
      { kind: 'playlist', id: 7 },
    ],
  );
  render(<MusicLibrary variant="desktop" />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings[0]).toBe('Pinned');
  const pinned = within(shelf('Pinned') as HTMLElement);
  expect(pinned.getAllByRole('button', { name: /^(Paper Satellites by|Old Mix$)/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Paper Satellites by Luma Vale', 'Old Mix']);
  const lists = within(shelf('Playlists') as HTMLElement);
  expect(lists.getAllByRole('button', { name: /^(New|Old) Mix$/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['New Mix', 'Old Mix']);
});

it('pins from a tile and unpins from the Pinned row, which then goes away', async () => {
  load([{ id: 7, name: 'Road Trip', trackIds: [1], updatedAt: 100 }], []);
  render(<MusicLibrary variant="desktop" />);
  expect(shelf('Pinned')).toBeNull();
  await act(async () => {
    fireEvent.click(within(shelf('Playlists') as HTMLElement).getByRole('button', { name: 'Pin Road Trip' }));
  });
  expect(setPinned).toHaveBeenLastCalledWith('playlist', 7, true);
  expect(useMusicPlayer.getState().library?.pins).toEqual([{ kind: 'playlist', id: 7 }]);
  const pinned = shelf('Pinned') as HTMLElement;
  expect(pinned).not.toBeNull();
  await act(async () => {
    fireEvent.click(within(pinned).getByRole('button', { name: 'Unpin Road Trip' }));
  });
  expect(setPinned).toHaveBeenLastCalledWith('playlist', 7, false);
  expect(shelf('Pinned')).toBeNull();
});

it('pins from an album page, and puts the pin back if saving fails', async () => {
  load([], []);
  render(<MusicLibrary variant="desktop" />);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Neon Harbour by Luma Vale' })[0]);
  });
  setPinned.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Listen Now' }));
  });
  expect(useMusicPlayer.getState().library?.pins).toEqual([]);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Listen Now' }));
  });
  expect(useMusicPlayer.getState().library?.pins).toEqual([{ kind: 'album', id: 1 }]);
  expect(screen.getByRole('button', { name: 'Unpin from Listen Now' }).getAttribute('aria-pressed')).toBe('true');
});
