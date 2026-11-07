import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as db from '../src/services/db';
import { play } from '../src/services/player';
import { canStreamTorrent, playTorrentByHash, pollTorrents, reapExpiredStreams, removeTorrent, resolvePlayablePathOrStream } from '../src/services/torrents';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { PlayerSession, TorrentRecord, TorrentStatus } from '../src/types/media';
import { movie, torrentRecord, torrentStatus } from './fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/db');
vi.mock('../src/services/enrich', () => ({ startBackgroundAnalysis: vi.fn() }));
vi.mock('../src/services/player', () => ({ play: vi.fn() }));

let record: TorrentRecord;
let live: TorrentStatus[];
const session = { target: { type: 'movie', id: 1, filePath: movie.file_path, startTime: 60, label: 'Sintel' } } as PlayerSession;

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState({ movies: [movie] });
  record = torrentRecord();
  live = [torrentStatus()];
  vi.mocked(db.listTorrentRecords).mockImplementation(async () => [record]);
  vi.mocked(db.loadLibrary).mockResolvedValue({ movies: [movie], series: [], episodes: [] });
  vi.mocked(db.listCollections).mockResolvedValue([]);
  vi.mocked(db.updateTorrentRecord).mockImplementation(async (_hash, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      Object.assign(record, { [key]: key === 'file_paths' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value });
    }
  });
  vi.mocked(invoke).mockImplementation(async (cmd) => cmd === 'torrent_list' ? live : undefined as never);
});

describe('torrent playback and completion', () => {
  it.each(['stop on complete', 'ratio limit', 'time limit'])('keeps range streaming alive at the %s boundary', async (policy) => {
    useLibraryStore.setState({ playerSession: session });
    if (policy === 'stop on complete') record.delete_on_complete = 1;
    if (policy === 'ratio limit') {
      useLibraryStore.setState((s) => ({ settings: { ...s.settings, torrent_seed_ratio_limit: 1 } }));
      live[0].uploaded_bytes = live[0].total_bytes;
    }
    if (policy === 'time limit') {
      record.completed_at = new Date(Date.now() - 120_000).toISOString();
      useLibraryStore.setState((s) => ({ settings: { ...s.settings, torrent_seed_time_mins: 1 } }));
    }
    await pollTorrents();
    expect(invoke).toHaveBeenCalledWith('torrent_action', { infoHash: 'abc123', action: 'pause' });
    expect(invoke).not.toHaveBeenCalledWith('torrent_action', { infoHash: 'abc123', action: 'delete_keep_files' });
    expect(useLibraryStore.getState().playerSession).toBe(session);

    useLibraryStore.setState({ playerSession: null });
    await pollTorrents();
    expect(invoke).toHaveBeenCalledWith('torrent_action', { infoHash: 'abc123', action: 'delete_keep_files' });
  });

  it('does not recreate a movie or erase progress when its torrent also includes extras', async () => {
    live[0].files.push({ ...live[0].files[0], index: 1, name: 'Extra.mp4', full_path: '/Movies/Sintel/Extra.mp4', size: 100 });
    await pollTorrents();
    await pollTorrents();
    expect(db.deleteMediaPaths).not.toHaveBeenCalled();
    expect(db.upsertMovie).not.toHaveBeenCalled();
    expect(useLibraryStore.getState().torrents[0].movieId).toBe(1);
  });

  it('defers moving a promoted stream until playback ends', async () => {
    record.save_path = '/Permanent/Sintel';
    useLibraryStore.setState({ playerSession: session });
    await pollTorrents();
    expect(invoke).not.toHaveBeenCalledWith('apply_moves', expect.anything());
    useLibraryStore.setState({ playerSession: null });
    await pollTorrents();
    expect(invoke).toHaveBeenCalledWith('apply_moves', { moves: [{ from: movie.file_path, to: '/Permanent/Sintel/Sintel.mp4' }] });
  });

  it('keeps persisted paths and retries a failed promotion after the torrent handle is gone', async () => {
    record.save_path = '/Permanent/Sintel';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'torrent_list') return live as never;
      if (cmd === 'apply_moves') throw new Error('Drive offline');
      return undefined as never;
    });
    await pollTorrents();
    expect(db.updateFilePaths).not.toHaveBeenCalled();
    expect(record.file_paths).toBe(JSON.stringify([movie.file_path]));
    live = [];
    vi.mocked(invoke).mockImplementation(async (cmd) => cmd === 'torrent_list' ? live : undefined as never);
    await pollTorrents();
    expect(db.updateFilePaths).toHaveBeenCalledWith([{ from: movie.file_path, to: '/Permanent/Sintel/Sintel.mp4' }]);
    warn.mockRestore();
  });
});

describe('torrent history retention', () => {
  beforeEach(() => {
    record.completed_at = new Date(Date.now() - 31 * 864e5).toISOString();
    live = [];
  });

  it('keeps history by default', async () => {
    await pollTorrents();
    expect(db.deleteTorrentRecord).not.toHaveBeenCalled();
  });

  it('clears only history after the configured age, preserving media and files', async () => {
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, torrent_history_days: 30 } }));
    await pollTorrents();
    expect(db.deleteTorrentRecord).toHaveBeenCalledWith('abc123');
    expect(db.deleteMediaPaths).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('torrent_action', expect.anything());
    expect(useLibraryStore.getState().torrents).toEqual([]);
  });

  it.each(['seeding', 'watching', 'stream', 'recent', 'incomplete'])('keeps %s tasks', async (state) => {
    useLibraryStore.setState((s) => ({ settings: { ...s.settings, torrent_history_days: 30 } }));
    if (state === 'seeding') live = [torrentStatus()];
    if (state === 'watching') useLibraryStore.setState({ playerSession: session });
    if (state === 'stream') record.mode = 'stream';
    if (state === 'recent') record.completed_at = new Date().toISOString();
    if (state === 'incomplete') record.completed_at = null;
    await pollTorrents();
    expect(db.deleteTorrentRecord).not.toHaveBeenCalled();
  });

  it('does not expire a cached stream being watched in VLC', async () => {
    record.mode = 'stream';
    record.expires_at = new Date(Date.now() - 60_000).toISOString();
    useLibraryStore.setState({ playback: { active: true, type: 'movie', id: 1, time: 60, length: 600 } });
    await reapExpiredStreams();
    expect(db.deleteTorrentRecord).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('deleting a torrent with its files', () => {
  it('keeps the library and transfer record after a native failure, then removes both on retry', async () => {
    vi.mocked(invoke).mockImplementationOnce(async () => { throw new Error('Disk is read only'); });

    await expect(removeTorrent(record.info_hash, true)).rejects.toThrow('Disk is read only');
    expect(db.deleteMediaPaths).not.toHaveBeenCalled();
    expect(db.deleteTorrentRecord).not.toHaveBeenCalled();

    await removeTorrent(record.info_hash, true);
    expect(db.deleteMediaPaths).toHaveBeenCalledWith([movie.file_path], [movie.file_path]);
    expect(db.deleteTorrentRecord).toHaveBeenCalledWith(record.info_hash);
  });
});

describe('streaming only user-chosen streams', () => {
  const downloading = () => torrentStatus({ finished: false, state: 'downloading', progress_pct: 42, progress_bytes: 110000,
    files: [{ ...torrentStatus().files[0], downloaded_bytes: 110000 }] });

  it.each([
    ['an unfinished download', () => { live = [downloading()]; }, false],
    ['an unfinished stream', () => { live = [downloading()]; record.mode = 'stream'; }, true],
    ['a promoted stream still in the stream cache', () => { live = [downloading()]; record.save_path = '/Permanent/Sintel'; }, true],
    ['a finished stream', () => { record.mode = 'stream'; }, false],
    ['a finished download', () => {}, false],
  ])('canStreamTorrent is correct for %s', async (_label, setup, expected) => {
    setup();
    const [item] = await pollTorrents();
    expect(canStreamTorrent(item)).toBe(expected);
  });

  it('refuses to stream an unfinished download from its transfer', async () => {
    live = [downloading()];
    await pollTorrents();
    await playTorrentByHash('abc123');
    expect(play).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('torrent_stream_url', expect.anything());
    expect(useLibraryStore.getState().toasts.at(-1)?.message).toBe('“Sintel” is still downloading — it will be playable when the download finishes.');
  });

  it('refuses to resolve a stream URL for an unfinished download but still streams a promoted stream', async () => {
    live = [downloading()];
    await pollTorrents();
    await expect(resolvePlayablePathOrStream(movie.file_path)).rejects.toThrow('still downloading');
    expect(invoke).not.toHaveBeenCalledWith('torrent_stream_url', expect.anything());

    record.save_path = '/Permanent/Sintel';
    await pollTorrents();
    await resolvePlayablePathOrStream(movie.file_path);
    expect(invoke).toHaveBeenCalledWith('torrent_stream_url', { infoHash: 'abc123', fileIndex: 0 });
  });

  it('plays a file the download already completed directly from disk', async () => {
    live = [downloading()];
    live[0].files.push({ ...live[0].files[0], index: 1, name: 'Extra.mp4', full_path: '/Movies/Sintel/Extra.mp4', size: 100, downloaded_bytes: 0 });
    await pollTorrents();
    await expect(resolvePlayablePathOrStream(movie.file_path)).rejects.toThrow();
    live[0].files[0].downloaded_bytes = live[0].files[0].size;
    await pollTorrents();
    await expect(resolvePlayablePathOrStream(movie.file_path)).resolves.toBe(movie.file_path);
    expect(invoke).not.toHaveBeenCalledWith('torrent_stream_url', expect.anything());
  });
});

describe('playing a selected season transfer', () => {
  it('starts an episode from that transfer rather than another season in the library', async () => {
    const { playTorrentByHash } = await import('../src/services/torrents');
    const { play } = await import('../src/services/player');
    const earlier = { id: 10, series_id: 9, season_number: 1, episode_number: 1, file_path: '/Shows/S01E01.mp4', watched: 0, progress_seconds: 0 };
    const selected = { id: 20, series_id: 9, season_number: 2, episode_number: 1, file_path: '/Shows/S02E01.mp4', watched: 0, progress_seconds: 0 };
    useLibraryStore.setState({ torrents: [{ infoHash: 'season-pack', seriesId: 9, movieId: null, filePaths: [selected.file_path], finished: true }] as never,
      episodes: [earlier, selected] as never, episodesBySeries: new Map([[9, [earlier, selected]]]) as never,
      items: [{ kind: 'tv', id: 9, title: 'Example', key: 'tv-9' }] as never });
    await playTorrentByHash('season-pack');
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ type: 'episode', id: 20, filePath: selected.file_path }));
  });
});
