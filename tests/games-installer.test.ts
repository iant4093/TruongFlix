import { describe, expect, it } from 'vitest';
import {
  buildInstallJob,
  buildOptions,
  chooseLanguage,
  defaultChoices,
  evaluateCondition,
  expandText,
  isRedistributable,
  languageMatches,
  requiredBytes,
  resolvePath,
  toggleComponent,
  visibleAfterInstall,
  visibleTasks,
} from '../src/games/installerOptions';
import type {
  ComponentOption,
  InstallerComponent,
  InstallerInfo,
  InstallerRunEntry,
  InstallerTask,
  KnownFolders,
} from '../src/games/types';

const comp = (name: string, description: string, languages: string, extra: Partial<InstallerComponent> = {}): InstallerComponent => ({
  name,
  description,
  types: 'full custom',
  languages,
  level: 0,
  size: 0,
  fixed: false,
  exclusive: false,
  dontInheritCheck: false,
  ...extra,
});

const run = (filename: string, description: string, languages: string, extra: Partial<InstallerRunEntry> = {}): InstallerRunEntry => ({
  filename,
  parameters: '',
  workingDir: null,
  description,
  postInstall: true,
  unchecked: false,
  skipIfSilent: false,
  shellExec: false,
  components: null,
  tasks: null,
  languages,
  ...extra,
});

const task = (name: string, extra: Partial<InstallerTask> = {}): InstallerTask => ({
  name,
  description: name,
  groupDescription: null,
  components: null,
  languages: null,
  level: 0,
  unchecked: false,
  exclusive: false,
  dontInheritCheck: false,
  ...extra,
});

const GAME = 'A Game About Chopping Trees';
const info: InstallerInfo = {
  setupExe: 'D:\\Downloads\\Chopping [Repack]\\setup.exe',
  appName: GAME,
  defaultDirName: `{code:NoSD}\\Games\\${GAME}`,
  extraDiskSpace: 3062233233,
  languages: [
    { name: 'en', display: 'English' },
    { name: 'russian', display: 'Русский' },
  ],
  types: [
    { name: 'custom', description: '{cm:TypeCustomDesc}', languages: null, isCustom: true },
    { name: 'full', description: '{cm:TypeFullDesc}', languages: null, isCustom: false },
  ],
  components: [
    comp('text', 'Основные файлы игры', 'russian', { fixed: true, size: 1000 }),
    comp('text', 'Main game files', 'en', { fixed: true, size: 1000 }),
    comp('directx', 'Обновить DirectX', 'russian'),
    comp('directx', 'Update DirectX', 'en', { size: 10 }),
    comp('vc_2022_x86', 'Download and Install C++ Redist 2015-2022 x86', 'en', { size: 20 }),
    comp('vc_2022_x64', 'Download and Install C++ Redist 2015-2022 x64', 'en', { size: 30 }),
  ],
  tasks: [],
  runEntries: [
    run('{app}\\_Redist\\QuickSFV.exe', 'Verify files integrity (recommended)', 'en', { parameters: 'repack.md5' }),
    run('{app}\\_Redist\\dxwebsetup.exe', 'Update DirectX', 'en', { components: 'directx' }),
    run('{app}\\_Redist\\vc_redist.x64.exe', 'Install Visual C++ Redist 2015-2022 x64', 'en', { components: 'vc_2022_x64' }),
    run('http://bit.ly/x', 'Open site', 'en', { shellExec: true }),
    run('cmd.exe', 'Redirect fake sites to the real one', 'en', { parameters: '/c ""{tmp}\\host.cmd""' }),
    run('{app}\\ChoppingTrees.exe', `{cm:LaunchProgram,${GAME}}`, '', { languages: null, skipIfSilent: true }),
    run('{app}\\_Redist\\dxwebsetup.exe', 'Обновить DirectX', 'russian', { components: 'directx' }),
  ],
  icons: [
    { name: `{group}\\${GAME}`, filename: '{app}\\ChoppingTrees.exe', components: null, tasks: null, languages: null },
    { name: `{commondesktop}\\${GAME}`, filename: '{app}\\ChoppingTrees.exe', components: null, tasks: null, languages: null },
  ],
  messages: [
    { name: 'LaunchProgram', value: 'Launch %1', language: 'en' },
    { name: 'LaunchProgram', value: 'Запустить %1', language: 'russian' },
    { name: 'TypeFullDesc', value: 'Installation with Software Updates', language: 'en' },
    { name: 'TypeCustomDesc', value: 'Default Installation', language: 'en' },
    { name: 'use2gb', value: 'Limit installer to 2 GB of RAM usage', language: 'en' },
    { name: 'use2gb', value: 'Ограничить 2 ГБ', language: 'russian' },
    { name: 'Greeting', value: '&Hello %1 && %2%nbye', language: null },
  ],
};

const folders: KnownFolders = {
  commonDesktop: 'C:\\Users\\Public\\Desktop',
  userDesktop: 'C:\\Users\\me\\Desktop',
  commonPrograms: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
  userPrograms: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
};

const ctx = { language: 'en', installRoot: 'E:\\Games\\', installRedists: false, desktopShortcut: true, totalRamGb: 16 };

describe('evaluateCondition', () => {
  const sel = new Set(['a', 'B', 'parent\\child']);
  it('handles operators', () => {
    expect(evaluateCondition(null, sel)).toBe(true);
    expect(evaluateCondition('', sel)).toBe(true);
    expect(evaluateCondition('a', sel)).toBe(true);
    expect(evaluateCondition('c', sel)).toBe(false);
    expect(evaluateCondition('a and b', sel)).toBe(true);
    expect(evaluateCondition('a and c', sel)).toBe(false);
    expect(evaluateCondition('c or b', sel)).toBe(true);
    expect(evaluateCondition('not c', sel)).toBe(true);
    expect(evaluateCondition('not (a or c)', sel)).toBe(false);
    expect(evaluateCondition('(c or a) and not (b and c)', sel)).toBe(true);
    expect(evaluateCondition('c d', sel)).toBe(false);
    expect(evaluateCondition('c A', sel)).toBe(true);
  });
  it('matches sub-item names case-insensitively', () => {
    expect(evaluateCondition('Parent\\Child', sel)).toBe(true);
    expect(evaluateCondition('parent\\other', sel)).toBe(false);
  });
  it('tolerates malformed input', () => {
    expect(evaluateCondition('(c and', sel)).toBe(true);
    expect(evaluateCondition('and or', sel)).toBe(true);
  });
});

describe('language and text', () => {
  it('matches languages', () => {
    expect(languageMatches(null, 'en')).toBe(true);
    expect(languageMatches('en russian', 'russian')).toBe(true);
    expect(languageMatches('russian', 'en')).toBe(false);
    expect(languageMatches('russian', null)).toBe(true);
  });

  it('expands custom messages', () => {
    expect(expandText(`{cm:LaunchProgram,${GAME}}`, info, 'en')).toBe(`Launch ${GAME}`);
    expect(expandText('{cm:LaunchProgram,X}', info, 'russian')).toBe('Запустить X');
    expect(expandText('{cm:Greeting,a,b}', info, 'en')).toBe('Hello a & b\nbye');
    expect(expandText('{cm:Missing}', info, 'en')).toBe('Missing');
  });

  it('chooses a language', () => {
    expect(chooseLanguage(info, ['en-US'])).toBe('en');
    expect(chooseLanguage(info, ['ru-RU', 'en'])).toBe('russian');
    expect(chooseLanguage(info, ['de-DE'])).toBe('en');
    expect(chooseLanguage({ ...info, languages: [] }, ['en'])).toBeNull();
  });

  it('detects redistributables', () => {
    expect(isRedistributable('directx', 'Update DirectX')).toBe(true);
    expect(isRedistributable('vc_2022_x64', 'Download and Install C++ Redist 2015-2022 x64')).toBe(true);
    expect(isRedistributable('{app}\\x\\vcredist_x86.exe', '')).toBe(true);
    expect(isRedistributable('net', 'Microsoft .NET Framework 4.8')).toBe(true);
    expect(isRedistributable('physx', 'NVIDIA PhysX')).toBe(true);
    expect(isRedistributable('ue', 'UE4PrereqSetup')).toBe(true);
    expect(isRedistributable('oal', 'oalinst.exe')).toBe(true);
    expect(isRedistributable('german', 'German language pack')).toBe(false);
    expect(isRedistributable('bonus', 'Bonus content: soundtrack')).toBe(false);
  });
});

describe('buildOptions', () => {
  const options = buildOptions(info, 'en');

  it('filters by language and dedupes', () => {
    expect(options.components.map((c) => [c.name, c.label, c.redist])).toEqual([
      ['text', 'Main game files', false],
      ['directx', 'Update DirectX', true],
      ['vc_2022_x86', 'Download and Install C++ Redist 2015-2022 x86', true],
      ['vc_2022_x64', 'Download and Install C++ Redist 2015-2022 x64', true],
    ]);
    expect(buildOptions(info, 'russian').components[1].label).toBe('Обновить DirectX');
    expect(options.types).toEqual([
      { name: 'custom', label: 'Default Installation', isCustom: true },
      { name: 'full', label: 'Installation with Software Updates', isCustom: false },
    ]);
    expect(options.limitRamLabel).toBe('Limit installer to 2 GB of RAM usage');
  });

  it('excludes verify, URL and launch entries from after-install', () => {
    expect(options.afterInstall.map((a) => [a.id, a.label, a.redist])).toEqual([
      ['1', 'Update DirectX', true],
      ['2', 'Install Visual C++ Redist 2015-2022 x64', true],
      ['4', 'Redirect fake sites to the real one', false],
    ]);
  });

  it('marks optional content that was not downloaded', () => {
    const withOptional: InstallerInfo = {
      ...info,
      components: [
        ...info.components,
        comp('bonus', 'Bonus Content: Soundtrack', 'en'),
        comp('japanese_voiceover', 'Japanese audio', 'en'),
        comp('german', 'German language', 'en'),
      ],
    };
    const opts = buildOptions(withOptional, 'en', ['fg-optional-bonus-content.bin', 'optional-japanese-voiceover-part1.bin']);
    expect(opts.components.filter((c) => c.unavailable).map((c) => c.name)).toEqual(['bonus', 'japanese_voiceover']);
    expect(buildOptions(withOptional, 'en', ['fg-optional-main-game-files']).components[0].unavailable).toBe(false);
  });
});

describe('defaultChoices', () => {
  const options = buildOptions(info, 'en');

  it('leaves redistributables off by default', () => {
    const c = defaultChoices(info, options, ctx);
    expect(c.installDir).toBe(`E:\\Games\\${GAME}`);
    expect(c.components).toEqual(['text']);
    expect(c.afterInstall).toEqual([]);
    expect(c.limitRam).toBe(false);
    expect(c.startMenu).toBe(true);
    expect(c.desktopShortcut).toBe(true);
  });

  it('includes redistributables when asked and limits RAM on small machines', () => {
    const c = defaultChoices(info, options, { ...ctx, installRedists: true, totalRamGb: 8 });
    expect(c.components).toEqual(['text', 'directx', 'vc_2022_x86', 'vc_2022_x64']);
    expect(c.afterInstall).toEqual(['1', '2']);
    expect(c.limitRam).toBe(true);
  });

  it('falls back to the app name and never selects unavailable components', () => {
    const other = { ...info, defaultDirName: '{pf}\\{code:Dir}', appName: 'Game: Part 2?' };
    expect(defaultChoices(other, options, ctx).installDir).toBe('E:\\Games\\Game Part 2');
    const missing = options.components.map((c) => (c.name === 'directx' ? { ...c, unavailable: true } : c));
    expect(defaultChoices(info, { ...options, components: missing }, { ...ctx, installRedists: true }).components).not.toContain('directx');
  });

  it('selects tasks by default when not unchecked and their components are selected', () => {
    const withTasks: InstallerInfo = {
      ...info,
      tasks: [task('desktopicon'), task('extras', { unchecked: true }), task('dx', { components: 'directx' })],
    };
    const opts = buildOptions(withTasks, 'en');
    const c = defaultChoices(withTasks, opts, ctx);
    expect(c.tasks).toEqual(['desktopicon']);
    expect(visibleTasks(opts, c).map((t) => t.name)).toEqual(['desktopicon', 'extras']);
  });

  it('shows after-install entries only for selected components', () => {
    const c = defaultChoices(info, options, ctx);
    expect(visibleAfterInstall(options, c).map((a) => a.id)).toEqual(['4']);
    expect(visibleAfterInstall(options, { ...c, components: ['text', 'directx'] }).map((a) => a.id)).toEqual(['1', '4']);
  });

  it('computes required bytes', () => {
    const c = defaultChoices(info, options, ctx);
    expect(requiredBytes(info, options, c)).toBe(3062233233 + 1000);
    expect(requiredBytes(info, options, { ...c, components: ['text', 'directx', 'vc_2022_x64'] })).toBe(3062233233 + 1040);
  });
});

describe('toggleComponent', () => {
  const opt = (name: string, level: number, extra: Partial<ComponentOption> = {}): ComponentOption => ({
    name,
    label: name,
    level,
    size: 0,
    fixed: false,
    exclusive: false,
    redist: false,
    unavailable: false,
    ...extra,
  });
  const tree = [
    opt('main', 0, { fixed: true }),
    opt('lang', 0),
    opt('lang\\en', 1, { exclusive: true }),
    opt('lang\\de', 1, { exclusive: true }),
    opt('bonus', 0),
    opt('bonus\\ost', 1),
    opt('bonus\\art', 1),
    opt('dlc', 0, { unavailable: true }),
  ];

  it('checks and unchecks descendants', () => {
    expect(toggleComponent(tree, ['main'], 'bonus', true)).toEqual(['main', 'bonus', 'bonus\\ost', 'bonus\\art']);
    expect(toggleComponent(tree, ['main', 'bonus', 'bonus\\ost', 'bonus\\art'], 'bonus', false)).toEqual(['main']);
  });

  it('keeps parents in sync with children', () => {
    expect(toggleComponent(tree, ['main'], 'bonus\\ost', true)).toEqual(['main', 'bonus', 'bonus\\ost']);
    expect(toggleComponent(tree, ['main', 'bonus', 'bonus\\ost'], 'bonus\\ost', false)).toEqual(['main']);
  });

  it('handles exclusive siblings', () => {
    expect(toggleComponent(tree, ['main'], 'lang', true)).toEqual(['main', 'lang', 'lang\\en']);
    expect(toggleComponent(tree, ['main', 'lang', 'lang\\en'], 'lang\\de', true)).toEqual(['main', 'lang', 'lang\\de']);
  });

  it('ignores fixed and unavailable items', () => {
    expect(toggleComponent(tree, ['main'], 'main', false)).toEqual(['main']);
    expect(toggleComponent(tree, ['main'], 'dlc', true)).toEqual(['main']);
  });
});

describe('install job', () => {
  it('resolves paths', () => {
    const c = { app: 'E:\\Games\\X', src: 'D:\\dl', folders };
    expect(resolvePath('{app}\\_Redist\\a.exe', c)).toBe('E:\\Games\\X\\_Redist\\a.exe');
    expect(resolvePath('{src}\\\\b.bin', c)).toBe('D:\\dl\\b.bin');
    expect(resolvePath('{commondesktop}\\X', c)).toBe('C:\\Users\\Public\\Desktop\\X');
    expect(resolvePath('{group}\\X', c)).toBe('{group}\\X');
    expect(resolvePath('{group}\\X', { ...c, group: 'G' })).toBe(`${folders.commonPrograms}\\G\\X`);
    expect(resolvePath('{sys}\\cmd.exe {win} {pf} {commonpf}', c)).toBe('C:\\Windows\\System32\\cmd.exe C:\\Windows C:\\Program Files C:\\Program Files');
    expect(resolvePath('{tmp}\\host.cmd', c)).toBe('{tmp}\\host.cmd');
  });

  it('builds the job', () => {
    const options = buildOptions(info, 'en');
    const choices = {
      ...defaultChoices(info, options, ctx),
      components: ['text', 'directx'],
      startMenu: false,
      desktopShortcut: false,
      afterInstall: ['1', '2', '4'],
    };
    const job = buildInstallJob(info, options, choices, { folders });
    expect(job.setupExe).toBe(info.setupExe);
    expect(job.installDir).toBe(`E:\\Games\\${GAME}`);
    expect(job.language).toBe('en');
    expect(job.components).toEqual(['text', 'directx']);
    expect(job.tasks).toBeNull();
    expect(job.noIcons).toBe(true);
    expect(job.limitRam).toBe(false);
    expect(job.removeShortcuts).toEqual([`C:\\Users\\Public\\Desktop\\${GAME}.lnk`]);
    expect(job.postActions).toEqual([
      { label: 'Update DirectX', filename: `E:\\Games\\${GAME}\\_Redist\\dxwebsetup.exe`, parameters: '', workingDir: null },
      { label: 'Redirect fake sites to the real one', filename: 'cmd.exe', parameters: '/c ""{tmp}\\host.cmd""', workingDir: null },
    ]);
    expect(buildInstallJob(info, options, { ...choices, desktopShortcut: true, startMenu: true }, { folders })).toMatchObject({
      noIcons: false,
      removeShortcuts: [],
    });
  });
});
