import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import ConfirmDialog from '../src/components/common/ConfirmDialog';
import DeleteMediaButton from '../src/components/modals/DeleteMediaButton';
import * as db from '../src/services/db';
import { deleteMedia } from '../src/services/files';
import { removeTorrent } from '../src/services/torrents';
import { buildMovieItem, groupEpisodes } from '../src/store/selectors';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { EpisodeRow, MediaItem } from '../src/types/media';
import { movie, torrentItem } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/torrents', () => ({ removeTorrent: vi.fn() }));

const hd = { ...movie, tmdb_id: 42, resolution: 'HD' };
const uhd = { ...hd, id: 2, file_path: '/Movies/Sintel/Sintel.2160p.mkv', resolution: '4K' };
const item = buildMovieItem([hd, uhd]);
const episode = {
  id: 3, series_id: 10, season_number: 1, episode_number: 3, title: 'Second wind',
  file_path: '/Shows/Example/S01E03.mp4', resolution: 'HD', file_size: null,
} as EpisodeRow;
const secondCopy = { ...episode, id: 4, file_path: '/Shows/Example/S01E03.2160p.mkv', resolution: '4K' };
const nextEpisode = { ...episode, id: 5, episode_number: 4, file_path: '/Shows/Example/S01E04.mp4' };
const series = { ...item, kind: 'tv', id: 10, title: 'Example' } as MediaItem;
const episodes = [episode, secondCopy, nextEpisode];

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState((state) => ({
    movies: [hd, uhd],
    episodesBySeries: groupEpisodes(episodes),
    settings: { ...state.settings, media_directories: ['/Movies', '/Shows'] },
    reload: vi.fn().mockResolvedValue(undefined),
  }));
  vi.mocked(invoke).mockResolvedValue({ entry_dir: '/Trash', items: [], size_bytes: 1 });
});
afterEach(cleanup);

it('defaults to the playback version and moves only the chosen movie file to Recently deleted', async () => {
  const onDeleted = vi.fn();
  render(<><DeleteMediaButton target={{ kind: 'movie', item }} versionId={hd.id} onDeleted={onDeleted} /><ConfirmDialog /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Delete movie' }));
  const chooser = screen.getByRole('dialog', { name: 'Choose versions to delete' });
  const defaultCopy = within(chooser).getByRole('radio', { name: /1080p/ }) as HTMLInputElement;
  expect(defaultCopy.checked).toBe(true);
  fireEvent.click(within(chooser).getByRole('radio', { name: /2160p\.mkv/ }));
  fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
  const confirm = screen.getByRole('alertdialog');
  expect(within(confirm).getByText(/This copy of the movie will be moved/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith('trash_media', { videoPaths: [uhd.file_path], root: '/Movies', filesOnly: true });
  expect(db.removeLibraryRows).toHaveBeenCalledWith([uhd.id], []);
});

it('deletes all copies of the chosen episode without including neighboring episodes', async () => {
  const onDeleted = vi.fn();
  render(<><DeleteMediaButton target={{ kind: 'episode', episode, series }} episodes={episodes} onDeleted={onDeleted} /><ConfirmDialog /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Delete episode' }));
  const chooser = screen.getByRole('dialog', { name: 'Choose versions to delete' });
  fireEvent.click(within(chooser).getByRole('radio', { name: 'All 2 versions' }));
  fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
  const confirm = screen.getByRole('alertdialog');
  expect(within(confirm).getByText(/All 2 versions of this episode will be moved/)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith('trash_media', { videoPaths: [episode.file_path, secondCopy.file_path], root: '/Shows', filesOnly: true });
  expect(db.removeLibraryRows).toHaveBeenCalledWith([], [episode.id, secondCopy.id]);
});

it('protects a retained version in the same unfinished transfer', async () => {
  const confirm = vi.fn();
  useLibraryStore.setState({ confirm, torrents: [torrentItem({ filePaths: [hd.file_path, uhd.file_path] })] });
  expect(await deleteMedia({ kind: 'movie', item, versionId: hd.id })).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(removeTorrent).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('trashes the local copy when deleting all versions also removes a separate transfer', async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  useLibraryStore.setState({ confirm, torrents: [torrentItem({ filePaths: [hd.file_path] })] });
  expect(await deleteMedia({ kind: 'movie', item })).toBe(true);
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    message: expect.stringContaining('The remaining selected files will be moved to Recently deleted.'),
  }));
  expect(removeTorrent).toHaveBeenCalledWith('abc123', true);
  expect(invoke).toHaveBeenCalledWith('trash_media', { videoPaths: [uhd.file_path], root: '/Movies' });
});
