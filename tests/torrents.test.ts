import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as db from '../src/services/db';
import { pollTorrents, reapExpiredStreams } from '../src/services/torrents';
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
