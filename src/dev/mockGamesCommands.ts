/** Dev-only stand-ins for the Windows Games commands (browser preview). */
import { emit } from '@tauri-apps/api/event';
import { gameArt, gamePosts, popularPage, TITLES } from './mockGames';

const installer = {
  setupExe: 'D:\\Downloads\\Game Installers\\Demo\\setup.exe',
  appName: 'Demo Game',
  defaultDirName: '{code:NoSD}\\Games\\Demo Game',
  extraDiskSpace: 3_062_233_233,
  languages: [{ name: 'en', display: 'English' }, { name: 'german', display: 'Deutsch' }],
  types: [{ name: 'custom', description: '{cm:TypeCustomDesc}', languages: null, isCustom: true }, { name: 'full', description: '{cm:TypeFullDesc}', languages: null, isCustom: false }],
  components: [
    { name: 'text', description: 'Main game files', types: 'full custom', languages: null, level: 0, size: 0, fixed: true, exclusive: false, dontInheritCheck: false },
    { name: 'bonus', description: 'Bonus content (artbook, soundtrack)', types: 'full custom', languages: null, level: 0, size: 820_000_000, fixed: false, exclusive: false, dontInheritCheck: false },
    { name: 'directx', description: 'Update DirectX', types: 'full custom', languages: null, level: 0, size: 0, fixed: false, exclusive: false, dontInheritCheck: false },
    { name: 'vc_2022_x64', description: 'Download and Install C++ Redist 2015-2022 x64', types: 'full custom', languages: null, level: 0, size: 0, fixed: false, exclusive: false, dontInheritCheck: false },
  ],
  tasks: [],
  runEntries: [
    { filename: '{app}\\_Redist\\QuickSFV.exe', parameters: 'checks.md5', workingDir: null, description: 'Verify files integrity (recommended)', postInstall: true, unchecked: false, skipIfSilent: false, shellExec: false, components: null, tasks: null, languages: null },
    { filename: '{app}\\_Redist\\dxwebsetup.exe', parameters: '', workingDir: null, description: 'Update DirectX', postInstall: true, unchecked: false, skipIfSilent: false, shellExec: false, components: 'directx', tasks: null, languages: null },
    { filename: '{app}\\_Redist\\vc_redist.x64.exe', parameters: '', workingDir: null, description: 'Install Visual C++ Redist 2015-2022 x64', postInstall: true, unchecked: false, skipIfSilent: false, shellExec: false, components: 'vc_2022_x64', tasks: null, languages: null },
    { filename: 'cmd.exe', parameters: '/c ""{tmp}\\host.cmd""', workingDir: null, description: 'Redirect fake sites to the real one', postInstall: true, unchecked: false, skipIfSilent: false, shellExec: false, components: null, tasks: null, languages: null },
    { filename: '{app}\\Demo.exe', parameters: '', workingDir: null, description: '{cm:LaunchProgram,Demo Game}', postInstall: true, unchecked: false, skipIfSilent: true, shellExec: false, components: null, tasks: null, languages: null },
  ],
  icons: [{ name: '{commondesktop}\\Demo Game', filename: '{app}\\Demo.exe', components: null, tasks: null, languages: null }],
  messages: [
    { name: 'TypeCustomDesc', value: 'Default Installation', language: null },
    { name: 'TypeFullDesc', value: 'Installation with Software Updates', language: null },
    { name: 'LaunchProgram', value: 'Launch %1', language: null },
    { name: 'use2gb', value: 'Limit installer to 2 GB of RAM usage', language: null },
  ],
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function simulate(jobId: string, steps: number, event: (n: number) => unknown, channel: string) {
  for (let n = 0; n <= steps; n++) {
    await wait(350);
    void emit(channel, { jobId, ...(event(n) as object) });
  }
}

/** Returns undefined for commands that aren't Games commands. */
export function handleGamesCommand(cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'games_source_get': {
      const path = String(a.path);
      if (path.startsWith('/wp-json/wp/v2/categories')) return { status: 200, totalPages: 1, body: JSON.stringify([{ id: 5, count: 7000 }, { id: 1, count: 40 }]) };
      if (path.startsWith('/popular-repacks')) return { status: 200, totalPages: null, body: popularPage };
      if (path.startsWith('/wp-json/wp/v2/posts')) {
        const url = new URL(path, 'https://games.example');
        const slug = url.searchParams.get('slug');
        const search = url.searchParams.get('search')?.toLowerCase();
        const posts = gamePosts.filter((p) => (!slug || p.slug === slug) && (!search || p.title.rendered.toLowerCase().includes(search)));
        return { status: 200, totalPages: 1, body: JSON.stringify(posts) };
      }
      return { status: 404, totalPages: null, body: '' };
    }
    case 'games_cache_image': {
      const url = String(a.url);
      const [, game, shot] = url.match(/(\d+)(?:-(\d+))?\.jpg/) ?? [];
      const index = Number(game ?? 0);
      return url.includes('shots.example') ? gameArt('', index * 5 + Number(shot ?? 0), 1280, 720) : gameArt(TITLES[index]?.[0] ?? '', index, 600, 900);
    }
    case 'games_inspect_installer':
      return wait(600).then(() => installer);
    case 'games_install': {
      const jobId = String(a.jobId);
      return (async () => {
        await wait(800);
        void emit('games-job', { jobId, event: { type: 'phase', phase: 'installing' } });
        await simulate(jobId, 20, (n) => ({ event: { type: 'progress', percent: n * 5, status: 'Unpacking...' } }), 'games-job');
        void emit('games-job', { jobId, event: { type: 'phase', phase: 'cleanup' } });
        await wait(400);
        return true;
      })();
    }
    case 'games_verify': {
      const jobId = String(a.jobId);
      const total = 3_060_000_000;
      return simulate(jobId, 10, (n) => ({ progress: { doneBytes: (total / 10) * n, totalBytes: total, filesDone: n * 11, filesTotal: 115, current: `Game\\Content\\pak_${n}.pak` } }), 'games-verify')
        .then(() => ({ available: true, filesChecked: 115, mismatched: [], missing: [] }));
    }
    case 'games_uninstall':
      return wait(1500).then(() => true);
    case 'games_launch':
      setTimeout(() => void emit('games-session', { gameId: a.gameId, seconds: 1860, error: null }), 5000);
      return null;
    case 'games_cancel': case 'games_delete_folder':
      return null;
    case 'games_is_running':
      return false;
    case 'games_disk_free':
      return 412_000_000_000;
    case 'games_total_memory_gb':
      return 32;
    case 'games_folder_size':
      return 3_060_259_255;
    case 'games_find_executables':
      return [{ path: `${String(a.installDir)}\\Demo.exe`, size: 344_576 }];
    case 'games_known_folders':
      return { commonDesktop: 'C:\\Users\\Public\\Desktop', userDesktop: 'C:\\Users\\you\\Desktop', commonPrograms: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs', userPrograms: 'C:\\Users\\you\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs' };
    default:
      return undefined;
  }
}

/** Repack-style file list for the demo games' magnets (hashes padded with "f"). */
export function gameTorrentFiles(source: string) {
  if (!/btih:f{20}/i.test(source)) return null;
  const name = decodeURIComponent(source.match(/dn=([^&]+)/)?.[1] ?? 'Demo').replace(/\+/g, ' ');
  const files = [
    ['setup.exe', 5_570_433], ['fg-01.bin', 1_961_964_374], ['fg-02.bin', 129_243_677],
    ['fg-optional-bonus-content.bin', 820_000_000], ['fg-selective-german.bin', 310_000_000], ['fg-selective-english.bin', 290_000_000],
    ['MD5/bins.md5', 148],
  ] as const;
  return {
    name,
    files: files.map(([path, size], index) => ({ index, name: path.split('/').pop()!, relative_path: `${name}/${path}`, size, is_video: false })),
  };
}
