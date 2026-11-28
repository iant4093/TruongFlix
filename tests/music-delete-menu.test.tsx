import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));

import MusicLibrary from '../src/music/components/MusicLibrary';
import MusicOverlays from '../src/music/components/Overlays';
import { assembleLibrary } from '../src/music/library';
import { openRoute, openTab } from '../src/music/nav';
import { setMusicLibrary, useMusicPlayer } from '../src/music/player';
import type { MusicApi } from '../src/music/api';
import type { MusicTrack } from '../src/music/types';

// Desktop Music offers "Show in File Explorer / Finder" and "Delete" for a song and an album; the
// browser app (no files) and a playlist's songs don't.

const track = (id: number, albumId: number): MusicTrack => ({
  id, title: `Song ${id}`, artist: 'Luma', artistId: 1, album: `Album ${albumId}`, albumId, albumArtist: 'Luma', albumArtistId: 1,
  trackNo: id, discNo: 1, year: 2023, genre: 'Pop', duration: 100, codec: 'mp3', art: null, favourite: false, plays: 0, lastPlayed: null, addedAt: 1000, hasLyrics: false,
});

const desktop = () => ({
  artUrl: () => null,
  setPinned: vi.fn(async () => undefined),
  deleteMusic: vi.fn(async () => true),
  revealMusic: vi.fn(async () => undefined),
});

function show(api: Partial<MusicApi>) {
  useMusicPlayer.setState({ api: api as MusicApi });
  setMusicLibrary(assembleLibrary([track(1, 5), track(2, 5), track(3, 6)], [{ id: 7, name: 'Mix', trackIds: [1, 3], updatedAt: 1 }]));
  render(<><MusicLibrary variant="desktop" /><MusicOverlays /></>);
}

afterEach(() => {
  cleanup();
  act(() => openTab('listen'));
});

it('deletes and shows an album from its page, then goes back', async () => {
  const api = desktop();
  show(api);
  act(() => openTab('albums'));
  act(() => openRoute({ page: 'album', id: 5 }));
  fireEvent.click(screen.getByRole('button', { name: 'More album options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Show in (File Explorer|Finder)/ }));
  await waitFor(() => expect(api.revealMusic).toHaveBeenCalledWith([1, 2]));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'More album options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Album…' }));
  await waitFor(() => expect(api.deleteMusic).toHaveBeenCalledWith({ kind: 'album', albumId: 5 }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'More album options' })).toBeNull());
});

it('deletes and shows one song from its row', async () => {
  const api = desktop();
  show(api);
  act(() => openRoute({ page: 'album', id: 5 }));
  fireEvent.click(screen.getByRole('button', { name: 'More options for Song 2' }));
  expect(screen.queryByRole('menuitem', { name: 'Delete Album…' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Song…' }));
  await waitFor(() => expect(api.deleteMusic).toHaveBeenCalledWith({ kind: 'song', trackId: 2 }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'More options for Song 1' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Show in/ }));
  await waitFor(() => expect(api.revealMusic).toHaveBeenCalledWith([1]));
});

it('offers neither in the browser app, nor for all of a playlist’s songs', () => {
  const { deleteMusic: _d, revealMusic: _r, ...browser } = desktop();
  show(browser);
  act(() => openRoute({ page: 'album', id: 5 }));
  fireEvent.click(screen.getByRole('button', { name: 'More album options' }));
  expect(screen.queryByRole('menuitem', { name: /Delete|Show in/ })).toBeNull();
  cleanup();

  show(desktop());
  act(() => openTab('playlists'));
  const card = screen.getAllByText('Mix').find((el) => el.closest('.group'))!.closest('.group')!;
  fireEvent.contextMenu(card);
  expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  expect(screen.queryByRole('menuitem', { name: /Delete|Show in/ })).toBeNull();
});
