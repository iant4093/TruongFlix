import { beforeEach, expect, it, vi } from 'vitest';
import * as db from '../src/services/db';

const data = vi.hoisted(() => ({ settings: new Map<string, string>(), torrents: [] as { mode: string; completed_at: string | null; save_path: string; file_paths: string }[] }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: vi.fn(async () => ({
    execute: async (query: string, values: unknown[] = []) => {
      if (query.includes('INSERT INTO settings')) data.settings.set(String(values[0]), String(values[1]));
      return { rowsAffected: 1, lastInsertId: 0 };
    },
    select: async (query: string) => {
      if (query.startsWith('PRAGMA')) return [];
      if (query.includes('COUNT(*) AS n FROM profiles')) return [{ n: 1 }];
      if (query.includes('FROM settings')) return [...data.settings].map(([key, value]) => ({ key, value }));
      if (query.includes('FROM torrents')) return data.torrents;
      return [];
    },
  })) },
}));

beforeEach(() => { data.settings.clear(); data.torrents = []; });

it('defaults history retention to Never and reloads the saved choice', async () => {
  expect((await db.getSettings()).torrent_history_days).toBe(0);
  await db.saveSetting('torrent_history_days', 30);
  expect((await db.getSettings()).torrent_history_days).toBe(30);
});

it('keeps promoted cached files protected from scans until they move into the library', async () => {
  data.torrents = [
    { mode: 'download', completed_at: '2026-10-01', save_path: '/Movies/Sintel', file_paths: '["/cache/Sintel.mp4"]' },
    { mode: 'download', completed_at: '2026-10-01', save_path: '/Movies/Other', file_paths: '["/Movies/Other/video.mp4"]' },
    { mode: 'download', completed_at: null, save_path: '/Movies/New', file_paths: '["/Movies/New/partial.mp4"]' },
    { mode: 'stream', completed_at: '2026-10-01', save_path: '/cache/stream', file_paths: '["/cache/stream/video.mp4"]' },
  ];
  expect([...(await db.getTorrentProtectedPaths())]).toEqual(['/cache/Sintel.mp4', '/Movies/New/partial.mp4', '/cache/stream/video.mp4']);
});
