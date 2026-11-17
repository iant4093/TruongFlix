/**
 * LRC lyrics: `[mm:ss.xx]line` timestamps (several per line allowed), `[offset:±ms]`, metadata tags
 * and "enhanced" word timing `<mm:ss.xx>word <mm:ss.xx>word`. Text without timestamps is plain.
 */

export interface LyricWord {
  time: number;
  end: number;
  text: string;
}

export interface LyricLine {
  time: number;
  end: number;
  text: string;
  /** Word timing (enhanced LRC, or estimated for line-timed lyrics), or null. */
  words: LyricWord[] | null;
  /** The word times were estimated from the line's length, not given by the lyrics. */
  estimated?: boolean;
}

export interface ParsedLyrics {
  synced: boolean;
  lines: LyricLine[];
  meta: Record<string, string>;
}

const STAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const WORD = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META = /^\[([a-zA-Z#]+):(.*)\]\s*$/;

function seconds(m: string, s: string, frac: string | undefined) {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(m) * 60 + Number(s) + f;
}

/** Splits enhanced word timing out of a line's text. */
function parseWords(raw: string, lineTime: number): { text: string; words: LyricWord[] | null } {
  const stamps = [...raw.matchAll(WORD)];
  if (!stamps.length) return { text: raw.trim(), words: null };
  const words: LyricWord[] = [];
  const lead = raw.slice(0, stamps[0].index).trim();
  if (lead) words.push({ time: lineTime, end: seconds(stamps[0][1], stamps[0][2], stamps[0][3]), text: lead });
  stamps.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const stop = i + 1 < stamps.length ? stamps[i + 1].index ?? raw.length : raw.length;
    const text = raw.slice(start, stop);
    const time = seconds(m[1], m[2], m[3]);
    if (!text.trim()) return; // a trailing stamp only marks where the last word ends
    const next = stamps[i + 1];
    words.push({ time, end: next ? seconds(next[1], next[2], next[3]) : NaN, text });
  });
  // Keep the spaces between words with the word before them, so the line reads naturally.
  const text = words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
  return { text, words: words.length ? words : null };
}

export function parseLrc(input: string, duration = 0): ParsedLyrics {
  const meta: Record<string, string> = {};
  const lines: LyricLine[] = [];
  const plain: string[] = [];
  for (const rawLine of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = rawLine.trim();
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = STAMP.exec(line))) {
      times.push(seconds(m[1], m[2], m[3]));
      line = line.slice(m[0].length);
    }
    if (!times.length) {
      const tag = META.exec(line);
      if (tag) {
        meta[tag[1].toLowerCase()] = tag[2].trim();
        continue;
      }
      plain.push(rawLine.trim());
      continue;
    }
    for (const t of times) {
      const { text, words } = parseWords(line, t);
      // The same words at another timestamp (a repeated chorus) need their own word times.
      const shifted = words && t !== times[0] ? words.map((w) => ({ ...w, time: w.time - times[0] + t, end: w.end - times[0] + t })) : words;
      lines.push({ time: t, end: NaN, text, words: shifted ? shifted.map((w) => ({ ...w })) : null });
    }
  }

  if (!lines.length) {
    // Plain lyrics: drop leading/trailing blank lines, keep blank lines between verses.
    while (plain.length && !plain[0]) plain.shift();
    while (plain.length && !plain[plain.length - 1]) plain.pop();
    return { synced: false, lines: plain.map((text) => ({ time: 0, end: 0, text, words: null })), meta };
  }

  const offset = Number(meta.offset) || 0; // ms; positive shows lyrics sooner
  lines.sort((a, b) => a.time - b.time);
  for (const l of lines) {
    l.time = Math.max(0, l.time - offset / 1000);
    if (l.words) for (const w of l.words) {
      w.time = Math.max(0, w.time - offset / 1000);
      w.end -= offset / 1000;
    }
  }
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    l.end = next ? next.time : Math.max(l.time + 5, duration || 0);
    if (l.words) {
      const last = l.words[l.words.length - 1];
      if (!Number.isFinite(last.end)) last.end = Math.min(l.end, last.time + Math.max(1, (l.end - last.time) * 0.8));
      for (const w of l.words) if (!Number.isFinite(w.end) || w.end < w.time) w.end = w.time;
    } else if (l.text) {
      l.words = estimateWords(l.text, l.time, l.end);
      l.estimated = true;
    }
  });
  return { synced: true, lines, meta };
}

/** About how long one word takes to sing, for lines that only have a start time. */
const SECONDS_PER_WORD = 0.55;

/**
 * Word times for a line that only says when it starts: the words share the time until the next
 * line (most of it, so the last word finishes before the next line begins, and never slower than
 * a slow singer), each in proportion to its length. Gives line-timed lyrics the word-by-word fill.
 */
export function estimateWords(text: string, start: number, end: number): LyricWord[] {
  const parts = text.match(/\S+\s*/g) ?? [];
  if (!parts.length) return [];
  const gap = Math.max(0.3, end - start);
  const sung = Math.min(gap * 0.9, Math.max(0.6, parts.length * SECONDS_PER_WORD));
  // Longer words take longer; every word gets a little time of its own.
  const weights = parts.map((p) => p.trim().length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const words: LyricWord[] = [];
  let t = start;
  parts.forEach((p, i) => {
    const len = (sung * weights[i]) / total;
    words.push({ time: t, end: t + len, text: p });
    t += len;
  });
  return words;
}

export type LyricEntry =
  | { kind: 'line'; time: number; end: number; text: string; words: LyricWord[] | null; estimated?: boolean }
  | { kind: 'gap'; time: number; end: number };

/** Gaps shorter than this don't get the "…" indicator. */
export const MIN_GAP = 6;

/**
 * What the lyrics view shows: sung lines plus instrumental breaks (intro, long pauses, or blank
 * timestamped lines), which get the animated three-dot indicator.
 */
export function lyricTimeline(lyrics: ParsedLyrics, minGap = MIN_GAP): LyricEntry[] {
  if (!lyrics.synced) return lyrics.lines.map((l) => ({ kind: 'line', time: 0, end: 0, text: l.text, words: null }));
  const out: LyricEntry[] = [];
  const sung = lyrics.lines;
  const firstSung = sung.find((l) => l.text);
  if (firstSung && firstSung.time >= minGap) out.push({ kind: 'gap', time: 0, end: firstSung.time });
  for (let i = 0; i < sung.length; i++) {
    const l = sung[i];
    if (!l.text) {
      // A blank timestamped line marks a break until the next line.
      if (l.end - l.time >= minGap && out.length && out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap', time: l.time, end: l.end });
      continue;
    }
    out.push({ kind: 'line', time: l.time, end: l.end, text: l.text, words: l.words, estimated: l.estimated });
    // With real word timing we know when singing stops; a long silence after that is a break too.
    const lastWord = l.estimated ? undefined : l.words?.[l.words.length - 1];
    const next = sung[i + 1];
    if (lastWord && next?.text && next.time - lastWord.end >= minGap) {
      out[out.length - 1].end = lastWord.end;
      out.push({ kind: 'gap', time: lastWord.end, end: next.time });
    }
  }
  return out;
}

/** Index of the entry playing at `t` (the last one that started), or -1 before the first. */
export function activeIndex(entries: { time: number }[], t: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].time <= t + 1e-6) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** 0…1 through a word (or any span). */
export function progressOf(span: { time: number; end: number }, t: number): number {
  if (t <= span.time) return 0;
  if (t >= span.end || span.end <= span.time) return 1;
  return (t - span.time) / (span.end - span.time);
}
