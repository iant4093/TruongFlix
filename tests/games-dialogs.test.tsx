import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import DownloadDialog from '../src/games/components/DownloadDialog';
import InstallDialog from '../src/games/components/InstallDialog';
import { downloadGame, inspectInstaller, installGame, missingOptionalFor, useGamesStore } from '../src/games/jobs';
import { DEFAULT_GAME_SETTINGS } from '../src/games/library';
import type { GameDetail, InstallerComponent, InstallerInfo, LibraryGame } from '../src/games/types';
import { inspectTorrentFilesLive } from '../src/services/torrents';
import type { InspectTorrentRes } from '../src/types/media';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../src/services/torrents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/torrents')>()),
  inspectTorrentFilesLive: vi.fn(),
}));
vi.mock('../src/games/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/games/library')>()),
  updateGame: vi.fn(async () => {}),
  saveGameSettings: vi.fn(async () => {}),
}));
vi.mock('../src/games/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/games/jobs')>()),
  downloadGame: vi.fn(),
  installGame: vi.fn(),
  inspectInstaller: vi.fn(),
  missingOptionalFor: vi.fn(() => []),
}));

const detail: GameDetail = {
  slug: 'test-game',
  title: 'Test Game',
  subtitle: 'v1.0',
  cover: null,
  postId: 1,
  date: null,
  link: 'https://example.invalid/test-game',
  genres: [],
  companies: [],
  languages: 'ENG/JAP',
  originalSize: '10 GB',
  repackSize: '5 GB',
  selective: true,
  magnet: 'magnet:?xt=urn:btih:abc',
  screenshots: [],
  features: [],
  description: '',
};

const torrentFiles = (paths: [string, number][]): InspectTorrentRes => ({
  info_hash: 'abc',
  name: 'Test Game',
  total_bytes: paths.reduce((s, [, n]) => s + n, 0),
  is_magnet: true,
  metadata_ready: true,
  files: paths.map(([p, size], index) => ({ index, name: p, relative_path: `Test Game/${p}`, size, is_video: false })),
  trackers: [],
});

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'games_disk_free') return 500e9;
    if (cmd === 'games_total_memory_gb') return 16;
    return null;
  });
  useGamesStore.setState({
    settings: {
      ...DEFAULT_GAME_SETTINGS,
      downloadDir: 'D:\\Downloads',
      installDir: 'E:\\Games',
      autoInstall: true,
      deleteInstaller: true,
      installRedists: false,
      desktopShortcut: true,
    },
    games: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DownloadDialog', () => {
  beforeEach(() => {
    vi.mocked(inspectTorrentFilesLive).mockResolvedValue(
      torrentFiles([
        ['setup.exe', 1000],
        ['fg-01.bin', 4000],
        ['fg-optional-bonus-content.bin', 300],
        ['fg-selective-english.bin', 200],
        ['fg-selective-japanese.bin', 250],
      ]),
    );
    vi.mocked(downloadGame).mockResolvedValue({} as LibraryGame);
  });

  it('groups optional files and passes the selected files to downloadGame', async () => {
    const onClose = vi.fn();
    const onStarted = vi.fn();
    render(<DownloadDialog detail={detail} onClose={onClose} onStarted={onStarted} />);

    const languages = await screen.findByRole('region', { name: 'Languages' });
    const extras = screen.getByRole('region', { name: 'Extras' });
    const english = within(languages).getByRole<HTMLInputElement>('checkbox', { name: /English/ });
    const japanese = within(languages).getByRole<HTMLInputElement>('checkbox', { name: /Japanese/ });
    const bonus = within(extras).getByRole<HTMLInputElement>('checkbox', { name: /Bonus Content/ });
    expect(english.checked).toBe(true);
    expect(japanese.checked).toBe(false);
    expect(bonus.checked).toBe(true);

    fireEvent.click(bonus);
    expect(bonus.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(downloadGame).toHaveBeenCalled());
    expect(vi.mocked(downloadGame).mock.calls[0][0]).toMatchObject({
      downloadDir: 'D:\\Downloads',
      onlyFiles: [0, 1, 3],
      autoInstall: true,
      deleteInstaller: true,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onStarted).toHaveBeenCalled();
  });

  it('sends null when everything is selected', async () => {
    render(<DownloadDialog detail={detail} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Japanese/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadGame).toHaveBeenCalled());
    expect(vi.mocked(downloadGame).mock.calls[0][0].onlyFiles).toBeNull();
  });

  it('hides the install folder when auto-install is off', async () => {
    render(<DownloadDialog detail={detail} onClose={() => {}} />);
    await screen.findByRole('region', { name: 'Languages' });
    expect(screen.getByTestId('install-folder').textContent).toContain('E:\\Games');
    fireEvent.click(screen.getByRole('switch', { name: 'Install automatically when the download finishes' }));
    expect(screen.queryByTestId('install-folder')).toBeNull();
    expect(screen.queryByText(/Uses your default install options/)).toBeNull();
  });

  it('offers to download everything when the file list fails', async () => {
    vi.mocked(inspectTorrentFilesLive).mockRejectedValue(new Error('timed out'));
    render(<DownloadDialog detail={detail} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('timed out'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download everything' }));
    await waitFor(() => expect(downloadGame).toHaveBeenCalled());
    expect(vi.mocked(downloadGame).mock.calls[0][0].onlyFiles).toBeNull();
  });
});

const comp = (name: string, description: string, extra: Partial<InstallerComponent> = {}): InstallerComponent => ({
  name,
  description,
  types: 'full',
  languages: null,
  level: 0,
  size: 0,
  fixed: false,
  exclusive: false,
  dontInheritCheck: false,
  ...extra,
});

const info: InstallerInfo = {
  setupExe: 'D:\\Downloads\\Test Game\\setup.exe',
  appName: 'Test Game',
  defaultDirName: '{code:NoSD}\\Games\\Test Game',
  extraDiskSpace: 1000,
  languages: [{ name: 'en', display: 'English' }],
  types: [{ name: 'full', description: 'Full', languages: null, isCustom: false }],
  components: [
    comp('main', 'Main game files', { fixed: true, size: 5000 }),
    comp('directx', 'Update DirectX', { size: 10 }),
    comp('bonus', 'Bonus Content', { size: 300 }),
  ],
  tasks: [],
  runEntries: [
    {
      filename: '{app}\\_Redist\\vc_redist.x64.exe',
      parameters: '/q',
      workingDir: null,
      description: 'Install Visual C++ Redist',
      postInstall: true,
      unchecked: false,
      skipIfSilent: false,
      shellExec: false,
      components: null,
      tasks: null,
      languages: null,
    },
  ],
  icons: [],
  messages: [],
};

const game: LibraryGame = {
  id: 7,
  slug: 'test-game',
  title: 'Test Game',
  subtitle: '',
  cover: null,
  detail,
  status: 'downloaded',
  infoHash: 'abc',
  installerDir: 'D:\\Downloads\\Test Game',
  installDir: null,
  exePath: null,
  autoInstall: false,
  deleteInstaller: true,
  choices: null,
  error: null,
  sizeBytes: null,
  playSeconds: 0,
  lastPlayed: null,
  installedAt: null,
  createdAt: '2026-01-01',
};

describe('InstallDialog', () => {
  beforeEach(() => {
    vi.mocked(inspectInstaller).mockResolvedValue(info);
    vi.mocked(missingOptionalFor).mockReturnValue(['fg-optional-bonus-content']);
    vi.mocked(installGame).mockResolvedValue();
  });

  it('shows components, unchecked redists and after-install entries, and installs with the choices', async () => {
    const onClose = vi.fn();
    render(<InstallDialog game={game} onClose={onClose} />);

    const components = await screen.findByRole('region', { name: 'Components' });
    const main = within(components).getByRole<HTMLInputElement>('checkbox', { name: /Main game files/ });
    const directx = within(components).getByRole<HTMLInputElement>('checkbox', { name: /Update DirectX/ });
    const bonus = within(components).getByRole<HTMLInputElement>('checkbox', { name: /Bonus Content/ });
    expect(main.checked).toBe(true);
    expect(main.disabled).toBe(true);
    expect(directx.checked).toBe(false);
    expect(within(components).getByText('System component')).toBeTruthy();
    expect(bonus.checked).toBe(false);
    expect(bonus.disabled).toBe(true);
    expect(within(components).getByText('Not downloaded')).toBeTruthy();

    const after = screen.getByRole('region', { name: 'After installing' });
    expect(within(after).getByRole<HTMLInputElement>('checkbox', { name: /Visual C\+\+/ }).checked).toBe(false);
    expect(within(after).getByText('Verify installed files (always runs)')).toBeTruthy();

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Install folder' }).value).toBe('E:\\Games\\Test Game');

    fireEvent.click(directx);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create a desktop shortcut' }));
    const install = screen.getByRole<HTMLButtonElement>('button', { name: 'Install' });
    await waitFor(() => expect(install.disabled).toBe(false));
    fireEvent.click(install);

    await waitFor(() => expect(installGame).toHaveBeenCalled());
    const [id, choices, passedInfo] = vi.mocked(installGame).mock.calls[0];
    expect(id).toBe(7);
    expect(passedInfo).toBe(info);
    expect(choices).toMatchObject({
      installDir: 'E:\\Games\\Test Game',
      components: ['main', 'directx'],
      desktopShortcut: false,
      startMenu: true,
      afterInstall: [],
    });
    expect(onClose).toHaveBeenCalled();
  });
});
