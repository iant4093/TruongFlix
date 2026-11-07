import { basename } from '../lib/path';

export interface GameFile {
  index: number;
  relative_path: string;
  size: number;
}

export interface OptionalGroup {
  /** Bin base name without part suffix, e.g. `fg-optional-bonus-content`. */
  key: string;
  label: string;
  kind: 'language' | 'extra';
  files: GameFile[];
  size: number;
}

const LANGUAGE_WORDS = new Set([
  'english', 'german', 'french', 'spanish', 'italian', 'russian', 'japanese', 'korean', 'chinese', 'portuguese',
  'brazilian', 'polish', 'turkish', 'arabic', 'czech', 'dutch', 'hungarian', 'swedish', 'ukrainian', 'thai',
  'latam', 'danish', 'finnish', 'norwegian', 'greek', 'romanian', 'vietnamese', 'indonesian', 'hebrew',
  'mexican', 'castilian', 'vo', 'voiceover', 'voiceovers', 'voices', 'dub', 'dubbing',
]);

const OPTIONAL_RE = /^((?:fg-)?(?:optional|selective)-)(.+)$/i;

/** `fg-optional-bonus-content.part2.bin` → { key: 'fg-optional-bonus-content', item: 'bonus-content' }. */
function optionalItem(path: string): { key: string; item: string } | null {
  const m = basename(path).toLowerCase().match(OPTIONAL_RE);
  if (!m) return null;
  const item = m[2].replace(/\.[a-z0-9]+$/, '').replace(/[-._]part\d+$/, '');
  return item ? { key: m[1] + item, item } : null;
}

const titleCase = (s: string) =>
  s
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

export function classifyFiles(files: GameFile[]): { required: GameFile[]; optional: OptionalGroup[] } {
  const required: GameFile[] = [];
  const groups = new Map<string, OptionalGroup>();
  for (const f of files) {
    const opt = optionalItem(f.relative_path);
    if (!opt) {
      required.push(f);
      continue;
    }
    let g = groups.get(opt.key);
    if (!g) {
      const label = titleCase(opt.item);
      const kind = label.toLowerCase().split(' ').some((w) => LANGUAGE_WORDS.has(w)) ? 'language' : 'extra';
      g = { key: opt.key, label, kind, files: [], size: 0 };
      groups.set(opt.key, g);
    }
    g.files.push(f);
    g.size += f.size;
  }
  return { required, optional: [...groups.values()] };
}

export function setupFileIndex(files: GameFile[]): number | null {
  const exes = files
    .filter((f) => /^setup.*\.exe$/i.test(basename(f.relative_path)))
    .sort((a, b) => a.relative_path.split(/[\\/]/).length - b.relative_path.split(/[\\/]/).length);
  const pick =
    exes.find((f) => /^setup[-_ ]?fixed.*\.exe$/i.test(basename(f.relative_path))) ??
    exes.find((f) => basename(f.relative_path).toLowerCase() === 'setup.exe') ??
    exes[0];
  return pick ? pick.index : null;
}

/** Keys of optional groups that are not fully selected for download. */
export function missingOptional(groups: OptionalGroup[], selectedIndices: number[]): string[] {
  const sel = new Set(selectedIndices);
  return groups.filter((g) => !g.files.every((f) => sel.has(f.index))).map((g) => g.key);
}
