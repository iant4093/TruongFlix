import { beforeEach, expect, it, vi } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import * as db from '../src/services/db';
import { hashPin, isHashedPin, storedPin, verifyAnyPin, verifyPin } from '../src/services/pin';

const data = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  keychain: new Map<string, string>(),
  keychainBroken: false,
  profiles: [] as { id: number; pin: string }[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (data.keychainBroken) throw new Error('keychain unavailable');
    if (cmd === 'secret_get') return data.keychain.get(args.key) ?? null;
    if (cmd === 'secret_set') return void data.keychain.set(args.key, args.value!);
    if (cmd === 'secret_delete') return void data.keychain.delete(args.key);
    throw new Error(`unexpected ${cmd}`);
  }),
}));

const fakeDb = {
  execute: async (query: string, values: unknown[] = []) => {
    if (query.includes('INSERT INTO settings')) data.settings.set(String(values[0]), String(values[1]));
    if (query.startsWith('DELETE FROM settings WHERE key = $1')) data.settings.delete(String(values[0]));
    if (query.startsWith('UPDATE profiles SET pin = $2')) {
      const p = data.profiles.find((x) => x.id === values[0] && x.pin === values[2]);
      if (p) p.pin = String(values[1]);
    }
    return { rowsAffected: 1, lastInsertId: 0 };
  },
  select: async (query: string) => {
    if (query.startsWith('PRAGMA')) return [];
    if (query.includes('COUNT(*) AS n FROM profiles')) return [{ n: 1 }];
    if (query.includes('FROM settings')) return [...data.settings].map(([key, value]) => ({ key, value }));
    if (query.includes('FROM profiles')) return data.profiles.map((p) => ({ ...p }));
    return [];
  },
};

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => fakeDb) } }));

beforeEach(() => {
  data.settings.clear();
  data.keychain.clear();
  data.keychainBroken = false;
  data.profiles = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const asDb = () => fakeDb as unknown as Database;

it('hashes PINs with a random salt and verifies them', async () => {
  const a = await hashPin('1234');
  const b = await hashPin('1234');
  expect(a).toMatch(/^pbkdf2\$150000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  expect(a).not.toBe(b);
  expect(await verifyPin(a, '1234')).toBe(true);
  expect(await verifyPin(a, '4321')).toBe(false);
  expect(await verifyPin(a, '')).toBe(false);
  expect(await verifyPin('', '')).toBe(false);
  expect(await verifyPin('pbkdf2$abc$$', '1234')).toBe(false);
  expect(await verifyPin(a.replace('150000', '99999999'), '1234')).toBe(false);
});

it('still accepts a plaintext PIN that was not migrated yet', async () => {
  expect(await verifyPin('1234', '1234')).toBe(true);
  expect(await verifyPin('1234', '1235')).toBe(false);
  expect(await verifyAnyPin(['', await hashPin('1111', 1000), '2222'], '1111')).toBe(true);
  expect(await verifyAnyPin(['', '2222'], '1111')).toBe(false);
});

it('stores only new PINs hashed and keeps stored hashes as they are', async () => {
  const hashed = await storedPin('5678');
  expect(isHashedPin(hashed)).toBe(true);
  expect(await storedPin(hashed)).toBe(hashed);
  expect(await storedPin('')).toBe('');
});

it('migrates plaintext PINs on startup', async () => {
  const already = await hashPin('9999', 1000);
  data.profiles = [{ id: 1, pin: '1234' }, { id: 2, pin: '' }, { id: 3, pin: already }];
  await db.migratePins(asDb());
  expect(isHashedPin(data.profiles[0].pin)).toBe(true);
  expect(await verifyPin(data.profiles[0].pin, '1234')).toBe(true);
  expect(data.profiles[1].pin).toBe('');
  expect(data.profiles[2].pin).toBe(already);
});

it('moves secret settings into the keychain and removes them from the database', async () => {
  data.settings.set('tmdb_api_key', 'tmdb-secret');
  data.settings.set('remote_code', '');
  data.settings.set('subtitle_language', 'fr');
  data.keychain.set('remote_code', 'stale');
  await db.migrateSecrets(asDb());
  expect(data.keychain.get('tmdb_api_key')).toBe('tmdb-secret');
  expect(data.keychain.has('remote_code')).toBe(false);
  expect([...data.settings.keys()]).toEqual(['subtitle_language']);
  const s = await db.getSettings();
  expect(s.tmdb_api_key).toBe('tmdb-secret');
  expect(s.subtitle_language).toBe('fr');
});

it('keeps secrets in the database when the keychain is unavailable', async () => {
  data.settings.set('omdb_api_key', 'omdb-secret');
  data.keychainBroken = true;
  await db.migrateSecrets(asDb());
  expect(data.settings.get('omdb_api_key')).toBe('omdb-secret');
  expect((await db.getSettings()).omdb_api_key).toBe('omdb-secret');

  await db.saveSetting('opensubtitles_password', 'pw');
  expect(data.settings.get('opensubtitles_password')).toBe('pw');
  expect((await db.getSettings()).opensubtitles_password).toBe('pw');
});

it('routes secret settings to the keychain and others to the database', async () => {
  await db.saveSetting('opensubtitles_api_key', 'os-key');
  await db.saveSetting('subtitle_language', 'de');
  expect(data.keychain.get('opensubtitles_api_key')).toBe('os-key');
  expect(data.settings.has('opensubtitles_api_key')).toBe(false);
  expect(data.settings.get('subtitle_language')).toBe('de');
  const s = await db.getSettings();
  expect(s.opensubtitles_api_key).toBe('os-key');
  expect(s.subtitle_language).toBe('de');

  await db.saveSetting('opensubtitles_api_key', '');
  expect(data.keychain.has('opensubtitles_api_key')).toBe(false);
  expect((await db.getSettings()).opensubtitles_api_key).toBe('');
});

it('prefers a newer database value (written while the keychain was down) over the keychain', async () => {
  data.keychain.set('tmdb_api_key', 'old');
  data.settings.set('tmdb_api_key', 'new');
  expect((await db.getSettings()).tmdb_api_key).toBe('new');
});
