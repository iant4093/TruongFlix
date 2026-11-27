import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));

import MusicLibrary from '../src/music/components/MusicLibrary';
import MusicOverlays from '../src/music/components/Overlays';
import { importPlaylistCover } from '../src/music/actions';
import { assembleLibrary } from '../src/music/library';
import { openRoute, openTab } from '../src/music/nav';
import { setMusicLibrary, useMusicPlayer } from '../src/music/player';
import type { MusicApi } from '../src/music/api';
import type { MusicPlaylist, MusicTrack } from '../src/music/types';

const track = (id: number, art: string): MusicTrack => ({
  id,
  title: `Song ${id}`,
  artist: 'Luma Vale',
  artistId: 1,
  album: `Album ${id}`,
  albumId: id,
  albumArtist: 'Luma Vale',
  albumArtistId: 1,
  trackNo: 1,
  discNo: 1,
  year: 2023,
  genre: 'Pop',
  duration: 100,
  codec: 'mp3',
  art,
  favourite: false,
  plays: 0,
  lastPlayed: null,
  addedAt: 1000,
  hasLyrics: false,
});

const mine = `${'d'.repeat(32)}.png`;
const imported = `${'a'.repeat(32)}.jpg`;
const api = {
  artUrl: (a: string | null | undefined) => (a ? `art://${a}` : null),
  setPinned: vi.fn(async () => undefined),
  setPlaylistDescription: vi.fn(async (_id: number, text: string) => text.replace(/\s+/g, ' ').trim()),
  setPlaylistCover: vi.fn(async (_id: number, image: Uint8Array | null) => (image ? { cover: mine, customCover: true } : { cover: imported, customCover: false })),
  importPlaylistCover: vi.fn(async () => ({ cover: imported, customCover: false })),
};

const playlist = (patch: Partial<MusicPlaylist> = {}): MusicPlaylist => ({ id: 7, name: 'Road Trip', trackIds: [1, 2], updatedAt: 100, ...patch });
const current = () => useMusicPlayer.getState().library!.playlists.find((p) => p.id === 7)!;
const underTitle = () => screen.getByRole('heading', { name: 'Road Trip', level: 2 }).nextElementSibling?.textContent;
const coverSrcs = () => Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src'));

function show(p: MusicPlaylist) {
  setMusicLibrary(assembleLibrary([track(1, 'one.jpg'), track(2, 'two.jpg')], [p]));
  render(
    <>
      <MusicLibrary variant="desktop" />
      <MusicOverlays />
    </>,
  );
  act(() => openRoute({ page: 'playlist', id: 7 }));
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  useMusicPlayer.setState({ api: api as unknown as MusicApi });
  openTab('playlists');
});
afterEach(() => {
  cleanup();
  useMusicPlayer.setState({ library: null, byId: new Map(), api: null });
});

it('shows the description under the title, and the playlist’s own cover instead of the mosaic', () => {
  show(playlist({ description: 'Songs for the drive', cover: imported, customCover: false }));
  expect(underTitle()).toBe('Songs for the drive');
  expect(coverSrcs()).toContain(`art://${imported}`);
});

it('adds, edits and takes off a description', async () => {
  show(playlist());
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Description' }));
  const field = await screen.findByPlaceholderText('Description (optional)');
  fireEvent.change(field, { target: { value: 'Songs for\nthe drive' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.setPlaylistDescription).toHaveBeenCalledWith(7, 'Songs for\nthe drive'));
  await waitFor(() => expect(current().description).toBe('Songs for the drive'));
  expect(underTitle()).toBe('Songs for the drive');

  // Emptied: no description.
  fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
  const again = await screen.findByPlaceholderText('Description (optional)');
  expect((again as HTMLTextAreaElement).value).toBe('Songs for the drive');
  expect(again.getAttribute('maxLength')).toBe('300');
  fireEvent.change(again, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(current().description).toBe(''));
  expect(underTitle()).not.toBe('Songs for the drive');
});

it('a description that can’t be saved is put back', async () => {
  show(playlist({ description: 'Before' }));
  api.setPlaylistDescription.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
  fireEvent.change(await screen.findByPlaceholderText('Description (optional)'), { target: { value: 'After' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.setPlaylistDescription).toHaveBeenCalled());
  await waitFor(() => expect(current().description).toBe('Before'));
});

it('picks a picture as the cover, and goes back to the default cover', async () => {
  show(playlist({ cover: imported, customCover: false }));
  // Nothing to go back to yet.
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.queryByRole('button', { name: 'Default Cover' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Change cover' })).toBeTruthy();

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fireEvent.change(screen.getByTestId('playlist-cover-file'), { target: { files: [new File([png], 'cover.png', { type: 'image/png' })] } });
  await waitFor(() => expect(api.setPlaylistCover).toHaveBeenCalledTimes(1));
  expect(Array.from(api.setPlaylistCover.mock.calls[0][1]!)).toEqual(Array.from(png));
  await waitFor(() => expect(current()).toMatchObject({ cover: mine, customCover: true }));
  expect(coverSrcs()).toContain(`art://${mine}`);

  fireEvent.click(await screen.findByRole('button', { name: 'Default Cover' }));
  await waitFor(() => expect(api.setPlaylistCover).toHaveBeenLastCalledWith(7, null));
  await waitFor(() => expect(current()).toMatchObject({ cover: imported, customCover: false }));
  expect(screen.queryByRole('button', { name: 'Default Cover' })).toBeNull();
});

it('a file that isn’t a picture isn’t sent', async () => {
  show(playlist());
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByTestId('playlist-cover-file'), { target: { files: [new File(['hi'], 'notes.txt', { type: 'text/plain' })] } });
  await screen.findByText('Pick a picture');
  expect(api.setPlaylistCover).not.toHaveBeenCalled();
});

it('an import’s artwork shows on the playlist (desktop only: the browser app has no importer)', async () => {
  setMusicLibrary(assembleLibrary([track(1, 'one.jpg')], [playlist()]));
  await importPlaylistCover(7, 'https://i.scdn.co/image/a');
  expect(api.importPlaylistCover).toHaveBeenCalledWith(7, 'https://i.scdn.co/image/a');
  expect(current()).toMatchObject({ cover: imported, customCover: false, updatedAt: 100 });
  // Nothing to do without artwork, or where imports don't run.
  await importPlaylistCover(7, null);
  useMusicPlayer.setState({ api: { ...api, importPlaylistCover: undefined } as unknown as MusicApi });
  await importPlaylistCover(7, 'https://i.scdn.co/image/b');
  expect(api.importPlaylistCover).toHaveBeenCalledTimes(1);
});
