import type {
  AfterInstallOption,
  ComponentOption,
  InstallChoices,
  InstallerInfo,
  InstallerMessage,
  InstallJobPayload,
  KnownFolders,
  TaskOption,
} from './types';
import { basename } from '../lib/path';

export interface InstallerOptions {
  components: ComponentOption[];
  tasks: TaskOption[];
  afterInstall: AfterInstallOption[];
  types: { name: string; label: string; isCustom: boolean }[];
  limitRamLabel: string | null;
}

const lower = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Evaluates an Inno `Components:`/`Tasks:` expression. Empty or malformed → true. */
export function evaluateCondition(expr: string | null, selected: Set<string>): boolean {
  if (!expr || !expr.trim()) return true;
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  const have = new Set([...selected].map(lower));
  let pos = 0;
  const fail = () => {
    throw new Error('bad condition');
  };
  const peek = () => tokens[pos]?.toLowerCase();
  const factor = (): boolean => {
    const t = tokens[pos++];
    if (t === undefined) return fail();
    const l = lower(t);
    if (l === 'not') return !factor();
    if (t === '(') {
      const v = orExpr();
      if (tokens[pos++] !== ')') fail();
      return v;
    }
    if (t === ')' || l === 'and' || l === 'or') return fail();
    return have.has(l);
  };
  const andExpr = (): boolean => {
    let v = factor();
    while (peek() === 'and') {
      pos++;
      v = factor() && v;
    }
    return v;
  };
  const orExpr = (): boolean => {
    let v = andExpr();
    // Legacy syntax: space-separated names mean "or".
    while (pos < tokens.length && peek() !== ')') {
      if (peek() === 'or') pos++;
      v = andExpr() || v;
    }
    return v;
  };
  try {
    const v = orExpr();
    return pos === tokens.length ? v : true;
  } catch {
    return true;
  }
}

export function languageMatches(languages: string | null, language: string | null): boolean {
  if (!languages?.trim() || !language) return true;
  return languages.toLowerCase().split(/\s+/).includes(lower(language));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function findMessage(info: InstallerInfo, name: string, language: string | null, strict = false): InstallerMessage | null {
  const all = info.messages.filter((m) => lower(m.name) === lower(name));
  return (
    (language ? all.find((m) => m.language && lower(m.language) === lower(language)) : undefined) ??
    all.find((m) => m.language === null) ??
    (strict && language ? undefined : all[0]) ??
    null
  );
}

const stripAccelerators = (s: string) => s.replace(/&&?/g, (m) => (m === '&&' ? '&' : ''));

function formatMessage(value: string, args: string[]): string {
  return value.replace(/%(\d+|n|%)/g, (m, k: string) => (k === 'n' ? '\n' : k === '%' ? '%' : (args[Number(k) - 1] ?? m)));
}

function expandMessages(text: string, info: InstallerInfo, language: string | null): string {
  return text.replace(/\{cm:([^,}]+)((?:,[^}]*)?)\}/gi, (_, name: string, rest: string) => {
    const args = rest ? rest.slice(1).split(',').map((a) => a.trim()) : [];
    const msg = findMessage(info, name.trim(), language);
    return msg ? formatMessage(msg.value, args) : name.trim();
  });
}

/** Expands `{cm:…}` messages for display (also `%n` and `&` accelerators). */
export function expandText(text: string, info: InstallerInfo, language: string | null): string {
  return stripAccelerators(expandMessages(text, info, language).replace(/%n/g, '\n'));
}

const REDIST_RE =
  /directx|dxwebsetup|dxsetup|visual\s*c\+\+|vc_?redist|vcredist|c\+\+\s*redist|\.net\b|dotnet|physx|\bxna\b|openal|oalinst|ue\d?prereq|prerequisite|redist/i;

export function isRedistributable(name: string, label: string): boolean {
  return REDIST_RE.test(`${name} ${label}`);
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'english', de: 'german', fr: 'french', es: 'spanish', it: 'italian', ru: 'russian', ja: 'japanese',
  ko: 'korean', zh: 'chinese', pt: 'portuguese', pl: 'polish', tr: 'turkish', ar: 'arabic', cs: 'czech',
  nl: 'dutch', hu: 'hungarian', sv: 'swedish', uk: 'ukrainian', th: 'thai', da: 'danish', fi: 'finnish',
  no: 'norwegian', nb: 'norwegian', el: 'greek', ro: 'romanian', vi: 'vietnamese', he: 'hebrew',
};

export function chooseLanguage(info: InstallerInfo, preferred: string[]): string | null {
  const langs = info.languages;
  if (!langs.length) return null;
  for (const p of preferred) {
    const code = lower(p).split(/[-_]/)[0];
    const full = LANGUAGE_NAMES[code];
    const hit = langs.find((l) => {
      const n = lower(l.name);
      const d = lower(l.display);
      return n === code || n === lower(p) || (!!full && (n.startsWith(full) || d.startsWith(full)));
    });
    if (hit) return hit.name;
  }
  return (langs.find((l) => ['en', 'english'].includes(lower(l.name))) ?? langs[0]).name;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Keeps language-matching items, one per name (preferring an explicit language match). */
function byLanguage<T extends { name: string; languages: string | null }>(items: T[], language: string | null): T[] {
  const explicit = (t: T) => !!language && !!t.languages && languageMatches(t.languages, language);
  const map = new Map<string, T>();
  for (const item of items) {
    if (!languageMatches(item.languages, language)) continue;
    const key = lower(item.name);
    const prev = map.get(key);
    if (!prev || (!explicit(prev) && explicit(item))) map.set(key, item);
  }
  return [...map.values()];
}

const words = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function optionalLabel(file: string): string {
  return lower(basename(file))
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[-._]part\d+$/, '')
    .replace(/^(fg-)?(optional|selective)-/, '');
}

function isMissing(name: string, label: string, missing: string[]): boolean {
  const have = new Set([...words(name), ...words(label)]);
  const norm = (s: string) => lower(s).replace(/[-_\s]+/g, '-');
  return missing.some((file) => {
    const l = optionalLabel(file);
    const tokens = words(l);
    return norm(name) === norm(l) || (tokens.length > 0 && tokens.every((t) => have.has(t)));
  });
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export function buildOptions(info: InstallerInfo, language: string | null, missingOptionalFiles: string[] = []): InstallerOptions {
  const text = (s: string) => expandText(s, info, language);
  const components = byLanguage(info.components, language).map((c): ComponentOption => {
    const label = text(c.description);
    return {
      name: c.name,
      label,
      level: c.level,
      size: c.size,
      fixed: c.fixed,
      exclusive: c.exclusive,
      redist: isRedistributable(c.name, label),
      unavailable: !c.fixed && missingOptionalFiles.length > 0 && isMissing(c.name, label, missingOptionalFiles),
    };
  });
  const tasks = byLanguage(info.tasks, language).map(
    (t): TaskOption => ({
      name: t.name,
      label: text(t.description),
      group: t.groupDescription ? text(t.groupDescription) : null,
      level: t.level,
      exclusive: t.exclusive,
      components: t.components,
    }),
  );
  const types = byLanguage(info.types, language).map((t) => ({ name: t.name, label: text(t.description), isCustom: t.isCustom }));
  const afterInstall: AfterInstallOption[] = [];
  info.runEntries.forEach((r, i) => {
    if (!r.postInstall || !languageMatches(r.languages, language)) return;
    if (r.shellExec || isUrl(r.filename)) return;
    // `{tmp}` is user-writable, so TruongFlix never runs anything from it with administrator rights.
    if ([r.filename, r.parameters, r.workingDir ?? ''].some((s) => /\{tmp\}/i.test(s))) return;
    if (/\{cm:LaunchProgram\b/i.test(r.description) || (r.skipIfSilent && /^\{app\}.*\.exe$/i.test(r.filename.trim()))) return;
    const label = text(r.description);
    if (/quicksfv/i.test(r.filename) || /verify|integrity/i.test(label)) return;
    afterInstall.push({
      id: String(i),
      label,
      filename: r.filename,
      parameters: r.parameters,
      workingDir: r.workingDir,
      components: r.components,
      tasks: r.tasks,
      redist: isRedistributable(r.filename, label),
    });
  });
  const ram = findMessage(info, 'use2gb', language, true);
  return { components, tasks, afterInstall, types, limitRamLabel: ram ? text(ram.value) : null };
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

const sanitize = (s: string) => s.replace(/[<>:"/\\|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');

const joinPath = (root: string, name: string) => `${root.replace(/[\\/]+$/, '')}\\${name}`;

export function defaultChoices(
  info: InstallerInfo,
  options: InstallerOptions,
  ctx: { language: string | null; installRoot: string; installRedists: boolean; desktopShortcut: boolean; totalRamGb: number },
): InstallChoices {
  const last = basename(expandMessages(info.defaultDirName, info, ctx.language));
  const folder = (!last.includes('{') && sanitize(last)) || sanitize(info.appName) || 'Game';

  const source = byLanguage(info.components, ctx.language);
  const typeName = options.types[0]?.name;
  const inType = (name: string) => {
    if (!typeName) return true;
    const c = source.find((x) => lower(x.name) === lower(name));
    return !!c?.types && lower(c.types).split(/\s+/).includes(lower(typeName));
  };
  const components = options.components
    .filter((c) => c.fixed || (!c.unavailable && (!c.redist || ctx.installRedists) && inType(c.name)))
    .map((c) => c.name);
  const compSet = new Set(components);

  const taskSource = byLanguage(info.tasks, ctx.language);
  const tasks = options.tasks
    .filter((t) => !taskSource.find((x) => lower(x.name) === lower(t.name))?.unchecked && evaluateCondition(t.components, compSet))
    .map((t) => t.name);
  const taskSet = new Set(tasks);

  const afterInstall = ctx.installRedists
    ? options.afterInstall
        .filter((a) => a.redist && evaluateCondition(a.components, compSet) && evaluateCondition(a.tasks, taskSet))
        .map((a) => a.id)
    : [];

  return {
    language: ctx.language,
    installDir: joinPath(ctx.installRoot, folder),
    components,
    tasks,
    startMenu: true,
    desktopShortcut: ctx.desktopShortcut,
    limitRam: options.limitRamLabel ? ctx.totalRamGb <= 8 : null,
    afterInstall,
  };
}

const parentIndex = (options: ComponentOption[], i: number) => {
  for (let k = i - 1; k >= 0; k--) if (options[k].level < options[i].level) return k;
  return -1;
};

const descendants = (options: ComponentOption[], i: number) => {
  const out: number[] = [];
  for (let j = i + 1; j < options.length && options[j].level > options[i].level; j++) out.push(j);
  return out;
};

const children = (options: ComponentOption[], i: number) => descendants(options, i).filter((j) => parentIndex(options, j) === i);

export function toggleComponent(options: ComponentOption[], selected: string[], name: string, checked: boolean): string[] {
  const sel = new Set(selected.map(lower));
  const ordered = () => options.filter((o) => sel.has(lower(o.name))).map((o) => o.name);
  const i = options.findIndex((o) => lower(o.name) === lower(name));
  if (i < 0 || options[i].fixed || options[i].unavailable) return ordered();
  const set = (j: number, on: boolean) => {
    const o = options[j];
    if (o.fixed || (on && o.unavailable)) return;
    if (on) sel.add(lower(o.name));
    else sel.delete(lower(o.name));
  };
  const uncheckTree = (j: number) => [j, ...descendants(options, j)].forEach((k) => set(k, false));

  if (checked) {
    set(i, true);
    if (options[i].exclusive) {
      const p = parentIndex(options, i);
      options.forEach((o, j) => {
        if (j !== i && o.exclusive && o.level === options[i].level && parentIndex(options, j) === p) uncheckTree(j);
      });
    }
    for (const j of descendants(options, i)) {
      const o = options[j];
      if (o.exclusive) {
        const p = parentIndex(options, j);
        const taken = options.some(
          (x, k) => k !== j && x.exclusive && x.level === o.level && parentIndex(options, k) === p && sel.has(lower(x.name)),
        );
        if (taken) continue;
      }
      set(j, true);
    }
  } else {
    uncheckTree(i);
  }
  // Parents follow their children: checked when any child is checked.
  for (let p = parentIndex(options, i); p >= 0; p = parentIndex(options, p)) {
    const any = children(options, p).some((j) => sel.has(lower(options[j].name)));
    set(p, any);
  }
  return ordered();
}

export function visibleAfterInstall(options: InstallerOptions, choices: InstallChoices): AfterInstallOption[] {
  const comps = new Set(choices.components);
  const tasks = new Set(choices.tasks);
  return options.afterInstall.filter((a) => evaluateCondition(a.components, comps) && evaluateCondition(a.tasks, tasks));
}

export function visibleTasks(options: InstallerOptions, choices: InstallChoices): TaskOption[] {
  const comps = new Set(choices.components);
  return options.tasks.filter((t) => evaluateCondition(t.components, comps));
}

export function requiredBytes(info: InstallerInfo, options: InstallerOptions, choices: InstallChoices): number {
  const sel = new Set(choices.components.map(lower));
  return options.components.reduce((sum, c) => (sel.has(lower(c.name)) ? sum + c.size : sum), info.extraDiskSpace);
}

// ---------------------------------------------------------------------------
// Install job
// ---------------------------------------------------------------------------

export function resolvePath(path: string, ctx: { app: string; src: string; folders: KnownFolders; group?: string }): string {
  const f = ctx.folders;
  const map: Record<string, string | undefined> = {
    app: ctx.app,
    src: ctx.src,
    commondesktop: f.commonDesktop,
    userdesktop: f.userDesktop,
    commonprograms: f.commonPrograms,
    userprograms: f.userPrograms,
    group: ctx.group ? `${f.commonPrograms}\\${ctx.group}` : undefined,
    sys: 'C:\\Windows\\System32',
    win: 'C:\\Windows',
    pf: 'C:\\Program Files',
    commonpf: 'C:\\Program Files',
  };
  const out = path.replace(/\{(\w+)\}/g, (m, k: string) => map[lower(k)] ?? m);
  return out.replace(/(?<!^)\\{2,}/g, '\\');
}

export function buildInstallJob(
  info: InstallerInfo,
  options: InstallerOptions,
  choices: InstallChoices,
  ctx: { folders: KnownFolders },
): InstallJobPayload {
  const cut = Math.max(info.setupExe.lastIndexOf('\\'), info.setupExe.lastIndexOf('/'));
  const src = cut >= 0 ? info.setupExe.slice(0, cut) : '';
  const where = { app: choices.installDir, src, folders: ctx.folders };
  const comps = new Set(choices.components);
  const tasks = new Set(choices.tasks);

  const removeShortcuts = choices.desktopShortcut
    ? []
    : info.icons
        .filter(
          (i) =>
            /^\{(common|user)desktop\}/i.test(i.name) &&
            languageMatches(i.languages, choices.language) &&
            evaluateCondition(i.components, comps) &&
            evaluateCondition(i.tasks, tasks),
        )
        .map((i) => `${resolvePath(expandMessages(i.name, info, choices.language), where)}.lnk`);

  const picked = new Set(choices.afterInstall);
  const postActions = visibleAfterInstall(options, choices)
    .filter((a) => picked.has(a.id))
    .map((a) => Number(a.id));

  return {
    installDir: choices.installDir,
    language: choices.language,
    components: info.components.length ? choices.components : null,
    tasks: info.tasks.length ? choices.tasks : null,
    noIcons: !choices.startMenu,
    limitRam: choices.limitRam,
    removeShortcuts,
    postActions,
  };
}
