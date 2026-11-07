import { describe, expect, it } from 'vitest';
import { arrangeLibrary, filterCounts, matchesFilter, parseLibraryTime, readViewPrefs, sortGames, DEFAULT_VIEW } from '../src/games/libraryView';
import type { LibraryGame } from '../src/games/types';

let nextId = 1;
function game(title: string, patch: Partial<LibraryGame> = {}): LibraryGame {
  return {
    id: nextId++, slug: title.toLowerCase().replace(/\W+/g, '-'), title, subtitle: '', cover: null, detail: null,
    status: 'installed', infoHash: null, installerDir: null, installDir: 'D:\\Games\\x', exePath: 'D:\\Games\\x\\x.exe',
    autoInstall: true, deleteInstaller: true, choices: null, error: null, sizeBytes: null, playSeconds: 0,
    lastPlayed: null, installedAt: null, createdAt: '2026-01-01 00:00:00', ...patch,
  };
}

const alpha = game('alpha Quest', { playSeconds: 3600, lastPlayed: '2026-11-05T20:00:00.000Z', sizeBytes: 10e9, createdAt: '2026-10-01 10:00:00' });
const beta = game('Beta 10', { playSeconds: 7200, lastPlayed: '2026-11-06T20:00:00.000Z', sizeBytes: 2e9, createdAt: '2026-09-01 10:00:00' });
const beta2 = game('Beta 2', { createdAt: '2026-11-01 10:00:00' });
const downloading = game('Downloading Game', { status: 'downloading', installDir: null, exePath: null, createdAt: '2026-11-03 10:00:00' });
const ready = game('Ready Game', { status: 'downloaded', installDir: null, exePath: null, installerDir: 'D:\\dl', createdAt: '2026-11-02 10:00:00', sizeBytes: 50e9 });
const failed = game('Failed Game', { status: 'install_failed', installDir: null, exePath: null, createdAt: '2026-08-01 10:00:00' });
const all = [ready, failed, beta2, alpha, downloading, beta];
const titles = (gs: LibraryGame[]) => gs.map((g) => g.title);

describe('parseLibraryTime', () => {
  it('reads SQLite UTC timestamps and ISO strings alike', () => {
    expect(parseLibraryTime('2026-11-01 10:00:00')).toBe(Date.parse('2026-11-01T10:00:00Z'));
    expect(parseLibraryTime('2026-11-01T10:00:00.000Z')).toBe(Date.parse('2026-11-01T10:00:00Z'));
    expect(parseLibraryTime(null)).toBe(0);
    expect(parseLibraryTime('garbage')).toBe(0);
  });
});

describe('sortGames', () => {
  it('recently played first, then never-played games by newest addition', () => {
    expect(titles(sortGames(all, 'played'))).toEqual(['Beta 10', 'alpha Quest', 'Downloading Game', 'Ready Game', 'Beta 2', 'Failed Game']);
  });
  it('recently added', () => {
    expect(titles(sortGames(all, 'added'))).toEqual(['Downloading Game', 'Ready Game', 'Beta 2', 'alpha Quest', 'Beta 10', 'Failed Game']);
  });
  it('name A–Z ignores case and orders numbers naturally', () => {
    expect(titles(sortGames(all, 'name'))).toEqual(['alpha Quest', 'Beta 2', 'Beta 10', 'Downloading Game', 'Failed Game', 'Ready Game']);
  });
  it('play time, most first, ties by name', () => {
    expect(titles(sortGames(all, 'playtime')).slice(0, 3)).toEqual(['Beta 10', 'alpha Quest', 'Beta 2']);
  });
  it('size, largest first, unknown sizes last', () => {
    expect(titles(sortGames(all, 'size'))).toEqual(['Ready Game', 'alpha Quest', 'Beta 10', 'Beta 2', 'Downloading Game', 'Failed Game']);
  });
  it('does not mutate the input', () => {
    const copy = [...all];
    sortGames(all, 'name');
    expect(all).toEqual(copy);
  });
});

describe('filters', () => {
  it('splits games into installed, in progress and ready to install', () => {
    expect(titles(all.filter((g) => matchesFilter(g, 'installed')))).toEqual(['Beta 2', 'alpha Quest', 'Beta 10']);
    expect(titles(all.filter((g) => matchesFilter(g, 'downloading')))).toEqual(['Downloading Game']);
    expect(titles(all.filter((g) => matchesFilter(g, 'ready')))).toEqual(['Ready Game']);
    expect(all.filter((g) => matchesFilter(g, 'all'))).toHaveLength(all.length);
  });
  it('a game with a running install job counts as in progress, not installed or ready', () => {
    const busy = (id: number) => id === ready.id || id === alpha.id;
    expect(matchesFilter(ready, 'ready', busy)).toBe(false);
    expect(matchesFilter(ready, 'downloading', busy)).toBe(true);
    expect(matchesFilter(alpha, 'installed', busy)).toBe(false);
    expect(matchesFilter(game('Leaving', { status: 'uninstalling' }), 'downloading', () => true)).toBe(false);
  });
  it('counts every chip', () => {
    expect(filterCounts(all)).toEqual({ all: 6, installed: 3, downloading: 1, ready: 1 });
  });
  it('arrangeLibrary filters, searches and sorts together', () => {
    expect(titles(arrangeLibrary(all, { filter: 'installed', sort: 'name', query: ' beta ' }))).toEqual(['Beta 2', 'Beta 10']);
    expect(titles(arrangeLibrary(all, { filter: 'all', sort: 'playtime' })).slice(0, 2)).toEqual(['Beta 10', 'alpha Quest']);
  });
});

describe('saved view', () => {
  it('reads saved choices and falls back on anything unknown', () => {
    expect(readViewPrefs(JSON.stringify({ layout: 'list', sort: 'size', filter: 'ready' }))).toEqual({ layout: 'list', sort: 'size', filter: 'ready' });
    expect(readViewPrefs(JSON.stringify({ layout: 'mosaic', sort: 'rating', filter: 3 }))).toEqual(DEFAULT_VIEW);
    expect(readViewPrefs('{not json')).toEqual(DEFAULT_VIEW);
    expect(readViewPrefs(null)).toEqual(DEFAULT_VIEW);
  });
});
