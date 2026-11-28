import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/services/db';
import { DEFAULT_GAME_SETTINGS, loadGameSettings, saveGameSettings, SETTING_KEYS as GAME_SETTING_KEYS } from '../src/games/library';
import { carriedPrefs, finishRestore, FOLDER_LABELS, restoredMessage } from '../src/services/backup';
import manifest from '../src/services/backupManifest.json';
import type { GameSettings } from '../src/games/types';
import type { Settings } from '../src/types/media';

/**
 * Backups (src-tauri/src/backup.rs) carry the settings table, the keychain values when asked, and
 * the tables and window-storage preferences listed in backupManifest.json; its Rust tests restore
 * every key and table listed there. These tests make sure nothing the app stores is missing from
 * that list: a setting or table added without a place in the manifest fails here.
 */

const data = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  keychain: new Map<string, string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'secret_get') return data.keychain.get(args.key) ?? null;
    if (cmd === 'secret_set') return void data.keychain.set(args.key, args.value!);
    if (cmd === 'secret_delete') return void data.keychain.delete(args.key);
    if (cmd === 'backup_restore_result') return restoreResult.value;
    throw new Error(`unexpected ${cmd}`);
  }),
}));

const restoreResult = vi.hoisted(() => ({ value: null as unknown }));

const fakeDb = {
  execute: async (query: string, values: unknown[] = []) => {
    if (query.includes('INSERT INTO settings')) data.settings.set(String(values[0]), String(values[1]));
    if (query.startsWith('DELETE FROM settings WHERE key = $1')) data.settings.delete(String(values[0]));
    return { rowsAffected: 1, lastInsertId: 0 };
  },
  select: async (query: string) => {
    if (query.startsWith('PRAGMA')) return [];
    if (query.includes('COUNT(*) AS n FROM profiles')) return [{ n: 1 }];
    if (query.includes('FROM settings')) return [...data.settings].map(([key, value]) => ({ key, value }));
    return [];
  },
};

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => fakeDb) } }));

beforeEach(() => {
  data.settings.clear();
  data.keychain.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

type Kind = keyof typeof manifest.settings;
const kinds = Object.keys(manifest.settings) as Kind[];
const kindOf = (key: string): Kind | undefined => kinds.find((kind) => (manifest.settings[kind] as string[]).includes(key));
const listed = kinds.flatMap((kind) => manifest.settings[kind] as string[]);
const gameKeys = Object.values(GAME_SETTING_KEYS);

/**
 * A value for each setting that differs from its default and survives loading. A new setting
 * that's a choice between a few words needs its own entry here.
 */
const CHANGED: Partial<Record<keyof Settings, unknown>> = {
  player_engine: 'vlc',
  tv_mode: 'on',
  torrent_default_mode: 'stream',
  soulseek_quality: 'mp3',
  subtitle_language: 'fr',
  audio_device: 'wasapi/hdmi',
  subtitle_style: { size: 'large', color: 'yellow', background: 'box', font: 'serif' },
  audio_delays: { 'wasapi/hdmi': 0.12 },
  network_shares: { '/Volumes/Media': { mount_point: '/Volumes/Media', url: 'smb://nas/Media', host: 'nas', kind: 'smb', mac: null } },
  remote_code: '482913',
};

function changed(key: string, fallback: unknown): unknown {
  if (key in CHANGED) return CHANGED[key as keyof Settings];
  if (typeof fallback === 'boolean') return !fallback;
  if (typeof fallback === 'number') return fallback + 9;
  if (Array.isArray(fallback)) return [`/old computer/${key}`];
  return `${key}-value`;
}

/** What a backup made on this computer restores on an empty one, per the manifest. */
function moveToNewComputer(withSecrets: boolean) {
  const rows = new Map<string, string>();
  for (const [key, value] of data.settings) {
    const kind = kindOf(key);
    if (!kind) throw new Error(`The setting ${key} isn't in src/services/backupManifest.json`);
    if (kind === 'secret' && !withSecrets) continue;
    if (kind === 'account' && !withSecrets) continue;
    rows.set(key, value);
  }
  if (withSecrets) for (const [key, value] of data.keychain) if (!rows.has(key)) rows.set(key, value);
  data.settings = rows;
  data.keychain = new Map();
}

describe('backup manifest', () => {
  it('lists every setting the app loads, and nothing else', async () => {
    const loaded = Object.keys(await db.getSettings());
    const missing = [...loaded, ...gameKeys].filter((key) => !kindOf(key));
    expect(missing, 'add these to src/services/backupManifest.json').toEqual([]);
    const stale = listed.filter((key) => !loaded.includes(key) && !gameKeys.includes(key));
    expect(stale, 'these are in the backup manifest but the app no longer has them').toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('keeps secrets the same as the keychain settings', () => {
    expect([...manifest.settings.secret].sort()).toEqual([...db.SECRET_SETTINGS].sort());
  });

  it('names every folder setting a backup lets you relink', () => {
    for (const key of [...manifest.settings.folders, ...manifest.settings.folder]) expect(FOLDER_LABELS[key], key).toBeTruthy();
  });

  it('lists every table the app creates', () => {
    const tables = [...manifest.tables.required, ...manifest.tables.optional, ...manifest.tables.local];
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|rs)$/.test(name) && !/(\.test\.|[\\/]dev[\\/]|[\\/]tests?\.rs$|[\\/]tests[\\/])/.test(path)) sources.push(path);
      }
    };
    walk('src');
    walk('src-tauri/src');
    const created = new Set<string>();
    for (const file of sources) {
      for (const m of readFileSync(file, 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)/g)) created.add(m[1]);
    }
    // Tables only the backup file itself has.
    for (const t of ['backup_meta', 'backup_local', 'backup_files']) created.delete(t);
    expect([...created].filter((t) => !tables.includes(t)), 'add these tables to src/services/backupManifest.json').toEqual([]);
    expect(created.size).toBeGreaterThan(20);
  });
});

describe('a setup moved to another computer', () => {
  it('comes back setting by setting, with passwords and keys', async () => {
    const defaults = await db.getSettings();
    for (const [key, fallback] of Object.entries(defaults)) await db.saveSetting(key as keyof Settings, changed(key, fallback) as string);
    const before = await db.getSettings();
    for (const [key, fallback] of Object.entries(defaults)) {
      expect(before[key as keyof Settings], `${key} needs a changed test value in CHANGED`).not.toEqual(fallback);
    }
    const games: GameSettings = { sourceUrl: 'https://games.example/', downloadDir: '/old computer/Downloads', installDir: '/old computer/Games', autoInstall: false, deleteInstaller: false, installRedists: true, desktopShortcut: false };
    await saveGameSettings(games);
    expect(await loadGameSettings()).not.toEqual(DEFAULT_GAME_SETTINGS);

    moveToNewComputer(true);
    expect(await db.getSettings()).toEqual(before);
    expect(await loadGameSettings()).toEqual(games);
  });

  it('comes back without passwords and keys when they were left out', async () => {
    const defaults = await db.getSettings();
    for (const [key, fallback] of Object.entries(defaults)) await db.saveSetting(key as keyof Settings, changed(key, fallback) as string);
    const before = await db.getSettings();
    moveToNewComputer(false);
    const after = await db.getSettings();
    for (const key of Object.keys(before) as (keyof Settings)[]) {
      const kind = kindOf(key);
      expect(after[key], key).toEqual(kind === 'secret' || kind === 'account' ? defaults[key] : before[key]);
    }
  });
});

describe('window-storage preferences', () => {
  it('carries only the listed ones', () => {
    const storage = new Map<string, string>([
      ['tf-track-langs', '{"show":"fr"}'],
      ['tf-pin-lockouts', '{}'],
      ['something-else', 'x'],
    ]);
    expect(carriedPrefs({ getItem: (k) => storage.get(k) ?? null })).toEqual({ 'tf-track-langs': '{"show":"fr"}' });
  });

  it('puts them back after a restore, and reports folders to relink', async () => {
    restoreResult.value = { local: { 'tf-music-volume': '0.4', 'tf-pin-lockouts': '{"x":1}' }, missing: ['/Volumes/Old'] };
    const written = new Map<string, string>();
    const restored = await finishRestore({ setItem: (k, v) => void written.set(k, v) });
    expect(Object.fromEntries(written)).toEqual({ 'tf-music-volume': '0.4' });
    expect(restored?.missing).toEqual(['/Volumes/Old']);
    expect(restoredMessage(restored!)).toMatch(/1 folder isn’t on this computer/);
    expect(restoredMessage({ local: {}, missing: [] })).toBe('TruongFlix backup restored');
  });
});
