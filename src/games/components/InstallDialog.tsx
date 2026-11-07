import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, FolderOpen, Gamepad2, Loader2 } from 'lucide-react';
import { Switch } from '../../components/settings/ui';
import { formatBytes } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { basename } from '../../lib/path';
import { useLibraryStore } from '../../store/useLibraryStore';
import {
  buildOptions,
  chooseLanguage,
  defaultChoices,
  languageMatches,
  requiredBytes,
  toggleComponent,
  visibleAfterInstall,
  visibleTasks,
  type InstallerOptions,
} from '../installerOptions';
import { folderName, inspectInstaller, installGame, joinPath, missingOptionalFor, useGamesStore } from '../jobs';
import { updateGame } from '../library';
import type { InstallChoices, InstallerInfo, LibraryGame, TaskOption } from '../types';
import { CARD, CARD_ROWS, CHECKBOX, GameDialog, pickFolder, Section, SELECT, useDiskFree } from './dialogParts';
import GameCover from './GameCover';

const lower = (s: string) => s.toLowerCase();

/** Keeps choices from a previous attempt where they still apply to these options. */
function mergePrevious(defaults: InstallChoices, prev: InstallChoices | null, options: InstallerOptions): InstallChoices {
  if (!prev) return defaults;
  const usable = new Set(options.components.filter((c) => !c.unavailable).map((c) => lower(c.name)));
  const fixed = options.components.filter((c) => c.fixed).map((c) => c.name);
  const prevComps = new Set(prev.components.map(lower));
  const components = options.components
    .filter((c) => fixed.includes(c.name) || (usable.has(lower(c.name)) && prevComps.has(lower(c.name))))
    .map((c) => c.name);
  const taskNames = new Set(options.tasks.map((t) => lower(t.name)));
  const afterIds = new Set(options.afterInstall.map((a) => a.id));
  return {
    language: defaults.language,
    installDir: prev.installDir || defaults.installDir,
    components: options.components.length ? components : defaults.components,
    tasks: prev.tasks.filter((t) => taskNames.has(lower(t))),
    startMenu: prev.startMenu,
    desktopShortcut: prev.desktopShortcut,
    limitRam: options.limitRamLabel ? (prev.limitRam ?? defaults.limitRam) : null,
    afterInstall: prev.afterInstall.filter((id) => afterIds.has(id)),
  };
}

interface Loaded {
  info: InstallerInfo;
  totalRamGb: number;
}

export default function InstallDialog({ game, onClose }: { game: LibraryGame; onClose: () => void }) {
  const settings = useGamesStore((s) => s.settings);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [choices, setChoices] = useState<InstallChoices | null>(null);
  const [typeName, setTypeName] = useState('');
  const [deleteInstaller, setDeleteInstaller] = useState(game.deleteInstaller);
  const [starting, setStarting] = useState(false);

  const missing = useMemo(() => missingOptionalFor(game), [game]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!game.installerDir) throw new Error('The installer for this game was not found.');
        const [info, totalRamGb] = await Promise.all([
          inspectInstaller(game.installerDir),
          invoke<number>('games_total_memory_gb').catch(() => 16),
        ]);
        if (cancelled) return;
        const s = useGamesStore.getState().settings;
        const prevLang = game.choices?.language;
        const lang =
          prevLang && info.languages.some((l) => l.name === prevLang) ? prevLang : chooseLanguage(info, [...navigator.languages]);
        const options = buildOptions(info, lang, missing);
        const defaults = defaultChoices(info, options, {
          language: lang,
          installRoot: s.installDir,
          installRedists: s.installRedists,
          desktopShortcut: s.desktopShortcut,
          totalRamGb: typeof totalRamGb === 'number' ? totalRamGb : 16,
        });
        setLanguage(lang);
        setTypeName(options.types[0]?.name ?? '');
        setChoices(mergePrevious({ ...defaults, afterInstall: [] }, game.choices, options));
        setLoaded({ info, totalRamGb: typeof totalRamGb === 'number' ? totalRamGb : 16 });
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const info = loaded?.info ?? null;
  const options = useMemo(() => (info ? buildOptions(info, language, missing) : null), [info, language, missing]);

  const free = useDiskFree(choices?.installDir ?? '');
  const needed = info && options && choices ? requiredBytes(info, options, choices) : 0;
  const notEnoughSpace = free != null && needed > free;

  const update = (patch: Partial<InstallChoices>) => setChoices((c) => (c ? { ...c, ...patch } : c));

  const changeLanguage = (lang: string) => {
    if (!info || !choices || !loaded) return;
    const opts = buildOptions(info, lang, missing);
    const defaults = defaultChoices(info, opts, {
      language: lang,
      installRoot: settings.installDir,
      installRedists: settings.installRedists,
      desktopShortcut: choices.desktopShortcut,
      totalRamGb: loaded.totalRamGb,
    });
    setLanguage(lang);
    setTypeName(opts.types[0]?.name ?? '');
    setChoices({
      ...defaults,
      afterInstall: [],
      installDir: choices.installDir,
      startMenu: choices.startMenu,
      desktopShortcut: choices.desktopShortcut,
      limitRam: opts.limitRamLabel ? (choices.limitRam ?? defaults.limitRam) : null,
    });
  };

  const changeType = (name: string) => {
    setTypeName(name);
    if (!info || !options || !choices) return;
    const type = options.types.find((t) => t.name === name);
    if (!type || type.isCustom) return;
    const current = new Set(choices.components.map(lower));
    const inType = (component: string) => {
      const src = info.components.find((c) => lower(c.name) === lower(component) && languageMatches(c.languages, language));
      return !!src?.types && lower(src.types).split(/\s+/).includes(lower(name));
    };
    const components = options.components
      .filter((c) => c.fixed || (!c.unavailable && (c.redist ? current.has(lower(c.name)) : inType(c.name))))
      .map((c) => c.name);
    update({ components });
  };

  const browse = async () => {
    if (!choices || !info) return;
    const picked = await pickFolder('Choose the install folder', choices.installDir);
    if (!picked) return;
    const leaf = folderName(info.appName || game.title);
    update({ installDir: lower(basename(picked)) === lower(leaf) ? picked : joinPath(picked, leaf) });
  };

  const toggleTask = (task: TaskOption, on: boolean, all: TaskOption[]) => {
    if (!choices) return;
    let tasks = choices.tasks.filter((t) => lower(t) !== lower(task.name));
    if (on) {
      if (task.exclusive) {
        const siblings = new Set(
          all.filter((t) => t !== task && t.exclusive && t.level === task.level && t.group === task.group).map((t) => lower(t.name)),
        );
        tasks = tasks.filter((t) => !siblings.has(lower(t)));
      }
      tasks.push(task.name);
    }
    update({ tasks });
  };

  const toggleList = (list: string[], item: string, on: boolean) => (on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item));

  const canInstall = !!info && !!options && !!choices && !!choices.installDir.trim() && !notEnoughSpace && !starting;

  const install = async () => {
    if (!canInstall || !choices || !options || !info) return;
    setStarting(true);
    const visible = new Set(visibleTasks(options, choices).map((t) => lower(t.name)));
    const final: InstallChoices = { ...choices, installDir: choices.installDir.trim(), tasks: choices.tasks.filter((t) => visible.has(lower(t))) };
    const toast = useLibraryStore.getState().toast;
    try {
      if (deleteInstaller !== game.deleteInstaller) {
        await updateGame(game.id, { deleteInstaller });
        useGamesStore.setState((s) => ({ games: s.games.map((g) => (g.id === game.id ? { ...g, deleteInstaller } : g)) }));
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    void installGame(game.id, final, info).catch((e) => toast(errorMessage(e), 'error'));
    onClose();
  };

  const tasks = options && choices ? visibleTasks(options, choices) : [];
  const taskGroups = tasks.reduce<{ group: string | null; items: TaskOption[] }[]>((acc, t) => {
    const last = acc[acc.length - 1];
    if (last && last.group === t.group) last.items.push(t);
    else acc.push({ group: t.group, items: [t] });
    return acc;
  }, []);
  const afterInstall = options && choices ? visibleAfterInstall(options, choices) : [];
  const selectedComps = new Set(choices?.components.map(lower) ?? []);
  const checkRow = 'flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-white/5';

  return (
    <GameDialog
      title={`Install ${game.title}`}
      subtitle={game.subtitle || 'Choose how this game is installed'}
      art={<GameCover url={game.cover} title={game.title} className="aspect-[2/3] w-10 shrink-0 rounded" />}
      onClose={onClose}
      wide
      footer={<>
        <button type="button" className="nf-btn-ghost h-10 px-4 text-sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="nf-btn-red h-10 px-5 text-sm disabled:opacity-40" disabled={!canInstall} onClick={() => void install()}>
          <Gamepad2 className="h-4 w-4" />
          Install
        </button>
      </>}
    >
      {!loaded && !loadError && (
        <p role="status" className={`${CARD} flex items-center gap-2.5 px-4 py-3.5 text-sm text-nf-secondary`}>
          <Loader2 className="h-4 w-4 animate-spin text-nf-red" /> Reading the installer…
        </p>
      )}
      {loadError && (
        <p role="alert" className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          {loadError}
        </p>
      )}

      {info && options && choices && (
        <div className="space-y-6">
          <Section title="Install folder" id="install-folder">
            <div className={`${CARD} space-y-2 px-4 py-3`}>
              <div className="flex gap-2">
                <input
                  aria-labelledby="install-folder"
                  value={choices.installDir}
                  onChange={(e) => update({ installDir: e.target.value })}
                  spellCheck={false}
                  className="nf-input h-10 min-w-0 flex-1 px-3 py-0 font-mono text-xs"
                />
                <button type="button" className="nf-btn-ghost h-10 shrink-0 px-3.5 py-0 text-sm" onClick={() => void browse()}>
                  <FolderOpen className="h-4 w-4" /> Browse
                </button>
              </div>
              {!choices.installDir.trim() ? (
                <p className="text-xs text-nf-red">Choose a folder to install to.</p>
              ) : (
                <p className={`text-xs ${notEnoughSpace ? 'text-nf-red' : 'text-nf-muted'}`}>
                  Needs {formatBytes(needed)}
                  {free != null && ` · ${formatBytes(free)} free on this drive`}
                  {notEnoughSpace && ' — not enough space.'}
                </p>
              )}
            </div>
          </Section>

          {(info.languages.length > 1 || options.types.length > 1) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {info.languages.length > 1 && (
                <Section title="Installer language" id="install-language">
                  <select aria-labelledby="install-language" value={language ?? ''} onChange={(e) => changeLanguage(e.target.value)} className={SELECT}>
                    {info.languages.map((l) => (
                      <option key={l.name} value={l.name} className="bg-[#181818]">
                        {l.display || l.name}
                      </option>
                    ))}
                  </select>
                </Section>
              )}
              {options.types.length > 1 && (
                <Section title="Setup type" id="install-type">
                  <select aria-labelledby="install-type" value={typeName} onChange={(e) => changeType(e.target.value)} className={SELECT}>
                    {options.types.map((t) => (
                      <option key={t.name} value={t.name} className="bg-[#181818]">
                        {t.label || t.name}
                      </option>
                    ))}
                  </select>
                </Section>
              )}
            </div>
          )}

          {options.components.length > 0 && (
            <Section title="Components" id="install-components">
              <ul className={CARD_ROWS}>
                {options.components.map((c) => {
                  const checked = selectedComps.has(lower(c.name));
                  const disabled = c.fixed || c.unavailable;
                  return (
                    <li key={c.name}>
                      <label
                        className={`flex items-center gap-3 py-2.5 pr-4 text-sm ${disabled ? 'cursor-default text-white/50' : 'cursor-pointer transition-colors hover:bg-white/5'}`}
                        style={{ paddingLeft: `${16 + c.level * 20}px` }}
                      >
                        <input
                          type="checkbox"
                          className={`${CHECKBOX} ${c.exclusive ? 'rounded-full' : ''}`}
                          checked={checked && !c.unavailable}
                          disabled={disabled}
                          onChange={(e) => update({ components: toggleComponent(options.components, choices.components, c.name, e.target.checked) })}
                        />
                        <span className="min-w-0 flex-1">{c.label}</span>
                        {c.redist && <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">System component</span>}
                        {c.unavailable && <span className="shrink-0 text-xs text-nf-muted">Not downloaded</span>}
                        {c.size > 0 && <span className="shrink-0 tabular-nums text-xs text-nf-muted">{formatBytes(c.size)}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {tasks.length > 0 && (
            <Section title="Additional tasks" id="install-tasks">
              <div className={`${CARD} space-y-3 px-4 py-3`}>
                {taskGroups.map((g, i) => (
                  <div key={`${g.group ?? ''}-${i}`} role="group" aria-label={g.group ?? 'Tasks'}>
                    {g.group && <div className="mb-1 text-sm font-semibold">{g.group}</div>}
                    {g.items.map((t) => (
                      <label key={t.name} className="flex cursor-pointer items-center gap-3 py-1 text-sm" style={{ paddingLeft: `${t.level * 20}px` }}>
                        <input
                          type="checkbox"
                          className={`${CHECKBOX} ${t.exclusive ? 'rounded-full' : ''}`}
                          checked={choices.tasks.some((x) => lower(x) === lower(t.name))}
                          onChange={(e) => toggleTask(t, e.target.checked, tasks)}
                        />
                        <span>{t.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Shortcuts" id="install-shortcuts">
            <div className={CARD_ROWS}>
              <label className={checkRow}>
                <input type="checkbox" className={CHECKBOX} checked={choices.startMenu} onChange={(e) => update({ startMenu: e.target.checked })} />
                Create a Start Menu folder
              </label>
              <label className={checkRow}>
                <input type="checkbox" className={CHECKBOX} checked={choices.desktopShortcut} onChange={(e) => update({ desktopShortcut: e.target.checked })} />
                Create a desktop shortcut
              </label>
            </div>
          </Section>

          {options.limitRamLabel && (
            <Section title="Installer settings" id="install-settings">
              <div className={CARD_ROWS}>
                <label className={`${checkRow} items-start`}>
                  <input type="checkbox" className={`${CHECKBOX} mt-0.5`} checked={!!choices.limitRam} onChange={(e) => update({ limitRam: e.target.checked })} />
                  <span>
                    {options.limitRamLabel}
                    <span className="mt-0.5 block text-xs text-nf-muted">Recommended on PCs with 8 GB of RAM or less.</span>
                  </span>
                </label>
              </div>
            </Section>
          )}

          <Section title="After installing" id="install-after">
            <div className={CARD_ROWS}>
              {afterInstall.map((a) => (
                <label key={a.id} className={checkRow}>
                  <input
                    type="checkbox"
                    className={CHECKBOX}
                    checked={choices.afterInstall.includes(a.id)}
                    onChange={(e) => update({ afterInstall: toggleList(choices.afterInstall, a.id, e.target.checked) })}
                  />
                  {a.label}
                </label>
              ))}
              <p className="flex items-center gap-3 px-4 py-2.5 text-sm text-nf-secondary">
                <Check className="h-4 w-4 shrink-0 text-nf-green" aria-hidden="true" />
                Verify installed files (always runs)
              </p>
            </div>
          </Section>

          <div className={`${CARD} flex items-center gap-4 px-4 py-3.5`}>
            <div className="flex-1">
              <div className="text-sm font-semibold">Delete the installer after installing</div>
              <div className="mt-0.5 text-xs leading-relaxed text-nf-muted">Seeding stops when the installer is deleted.</div>
            </div>
            <Switch checked={deleteInstaller} onChange={setDeleteInstaller} label="Delete the installer after installing" />
          </div>
        </div>
      )}
    </GameDialog>
  );
}

