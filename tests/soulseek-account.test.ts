import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (s: string) => s }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../src/services/db', () => ({ saveSetting: vi.fn(async () => {}) }));

import { saveSetting } from '../src/services/db';
import { connectSoulseek, newSoulseekAccount, useMusicDownloads } from '../src/services/musicDownloads';
import { useLibraryStore } from '../src/store/useLibraryStore';

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' }, jobs: {} });
});

const logins = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'slsk_connect').map(([, args]) => args as { username: string; password: string });

it('makes up an account when there is none, and keeps it', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'slsk_status') return { state: 'offline', username: '', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') return { state: 'online', username: (args as { username: string }).username, message: '' };
    return undefined;
  });
  const status = await connectSoulseek();
  const { soulseek_username, soulseek_password } = useLibraryStore.getState().settings;
  // Purely random: nothing in the name says TruongFlix.
  expect(soulseek_username).toMatch(/^[a-z][a-z0-9]{11}$/);
  const names = Array.from({ length: 40 }, () => newSoulseekAccount().soulseek_username);
  expect(new Set(names.map((n) => n.slice(0, 2))).size).toBeGreaterThan(20);
  expect(useLibraryStore.getState().settings.soulseek_made_up).toBe(true);
  expect(soulseek_password).toHaveLength(24);
  expect(status.username).toBe(soulseek_username);
  expect(logins()).toEqual([expect.objectContaining({ username: soulseek_username, password: soulseek_password })]);
  // Saved like any other setting (into the keychain).
  expect(saveSetting).toHaveBeenCalledWith('soulseek_username', soulseek_username);
  expect(saveSetting).toHaveBeenCalledWith('soulseek_password', soulseek_password);
  expect(saveSetting).toHaveBeenCalledWith('soulseek_made_up', true);
  // Every account is different.
  expect(newSoulseekAccount().soulseek_username).not.toBe(newSoulseekAccount().soulseek_username);
});

it('an account made by 2.0.116 (named "tf…") is swapped for a purely random one', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'slsk_status') return { state: 'offline', username: '', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') return { state: 'online', username: (args as { username: string }).username, message: '' };
    return undefined;
  });
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_username: 'tfa1b2c3d4e5', soulseek_password: 'x'.repeat(24) } }));
  await connectSoulseek();
  expect(logins()).toEqual([expect.objectContaining({ username: expect.not.stringMatching(/^tf/) })]);
  expect(useLibraryStore.getState().settings).toMatchObject({ soulseek_made_up: true });
});

it('a made-up name someone already has is swapped for another; a typed-in account is left to the user', async () => {
  let refusals = 1;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'slsk_status') return { state: 'offline', username: '', message: '' };
    if (cmd === 'slsk_jobs') return [];
    if (cmd === 'slsk_connect') {
      if (refusals-- > 0) throw 'Soulseek didn’t accept that username and password.';
      return { state: 'online', username: (args as { username: string }).username, message: '' };
    }
    return undefined;
  });
  await connectSoulseek();
  const tried = logins();
  expect(tried).toHaveLength(2);
  expect(tried[0].username).not.toBe(tried[1].username);
  expect(useLibraryStore.getState().settings.soulseek_username).toBe(tried[1].username);

  vi.mocked(invoke).mockClear();
  refusals = 5;
  useMusicDownloads.setState({ status: { state: 'offline', username: '', message: '' } });
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, soulseek_username: 'ian', soulseek_password: 'wrong', soulseek_made_up: false } }));
  await expect(connectSoulseek()).rejects.toBe('Soulseek didn’t accept that username and password.');
  expect(logins()).toHaveLength(1);
  expect(useLibraryStore.getState().settings.soulseek_username).toBe('ian');
});
