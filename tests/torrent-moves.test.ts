import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

describe('moving torrent files into the library', () => {
  it('keeps season folders, so episodes with the same name never collide', async () => {
    const { planTorrentMoves } = await import('../src/services/torrents');
    const moves = planTorrentMoves(['C:\\DL\\Show\\Season 1\\E01.mkv', 'C:\\DL\\Show\\Season 2\\E01.mkv'], 'D:\\TV\\Show (2020)');
    expect(moves.map((m) => m.to)).toEqual(['D:\\TV\\Show (2020)\\Season 1\\E01.mkv', 'D:\\TV\\Show (2020)\\Season 2\\E01.mkv']);
  });

  it('keeps the season folder when only one season is moved (a retry)', async () => {
    const { planTorrentMoves } = await import('../src/services/torrents');
    expect(planTorrentMoves(['C:\\Cache\\abc\\Show\\Season 2\\E01.mkv'], 'D:\\TV\\Show')[0].to).toBe('D:\\TV\\Show\\Season 2\\E01.mkv');
  });

  it('moves a single file straight into the folder', async () => {
    const { planTorrentMoves } = await import('../src/services/torrents');
    expect(planTorrentMoves(['/dl/Movie.2020/movie.mkv'], '/lib/Movie (2020)')[0].to).toBe('/lib/Movie (2020)/movie.mkv');
  });
});
