/**
 * Play stats belong to the game, not to one install: sessions are matched to a library game by
 * its source slug or by its normalised title, so uninstalling, removing, redownloading (another
 * repack version, another folder) keeps the history.
 */

/** Edition words dropped from a title so "X Deluxe Edition" and "X" are the same game. */
const EDITION = /\b(?:digital\s+)?(?:deluxe|gold|ultimate|complete|definitive|premium|standard|special|collector'?s|anniversary|goty|game of the year)(?:\s+edition)?\s*$/;

/**
 * A stable identity for a game from its title: case, accents, punctuation, trademark signs,
 * version numbers, "+ N DLCs" and edition names don't matter.
 */
export function gameKey(title: string): string {
  let t = title
    .replace(/[™®©℠]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ');
  // Repack details that sometimes stay in the title.
  t = t.replace(/\s*\+\s*\d*\s*(?:dlcs?|bonus\w*|updates?)\b.*$/, '');
  t = t.replace(/\s*[([]?\b(?:v|ver\.?|version|build|update)\s*\d[\w.\-]*[)\]]?/g, ' ');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(EDITION, '').trim();
  }
  return t || title.trim().toLowerCase();
}

/** The parts of a stored play session the stats need. */
export interface StatSession {
  slug: string;
  gameKey: string | null;
  title: string;
  startedAt: string;
  seconds: number;
  /** Rebuilt from a total recorded before sessions were logged: its day and count aren't known. */
  estimated: boolean;
}

export interface GameStats {
  totalSeconds: number;
  /** Sessions with a known start (estimated history isn't counted). */
  launches: number;
  /** Some play time comes from before sessions were logged, so `launches` is a lower bound. */
  hasEstimated: boolean;
  firstPlayed: string | null;
  /** `firstPlayed` is only "on or before" (the earliest record is an estimate). */
  firstPlayedApprox: boolean;
  /** When the last session ended. */
  lastPlayed: string | null;
  longestSeconds: number;
  weekSeconds: number;
  monthSeconds: number;
}

export const EMPTY_STATS: GameStats = {
  totalSeconds: 0, launches: 0, hasEstimated: false, firstPlayed: null, firstPlayedApprox: false,
  lastPlayed: null, longestSeconds: 0, weekSeconds: 0, monthSeconds: 0,
};

/** Whether a session was played in this game (any install of it). */
export function belongsTo(session: Pick<StatSession, 'slug' | 'gameKey' | 'title'>, game: { slug: string; title: string }) {
  return session.slug === game.slug || (session.gameKey ?? gameKey(session.title)) === gameKey(game.title);
}

/** Monday 00:00 of this week, local time. */
export function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Seconds of [start, end) that fall on or after `from`. */
const since = (start: number, end: number, from: number) => Math.max(0, (end - Math.max(start, from)) / 1000);

export function statsFor(game: { slug: string; title: string }, sessions: StatSession[], now = new Date()): GameStats {
  const mine = sessions.filter((s) => s.seconds > 0 && belongsTo(s, game));
  if (!mine.length) return EMPTY_STATS;
  const week = startOfWeek(now).getTime();
  const month = startOfMonth(now).getTime();
  const out = { ...EMPTY_STATS };
  let first = Infinity;
  let last = -Infinity;
  for (const s of mine) {
    const start = Date.parse(s.startedAt);
    if (Number.isNaN(start)) continue;
    out.totalSeconds += s.seconds;
    if (start < first) {
      first = start;
      out.firstPlayedApprox = s.estimated;
    }
    if (s.estimated) {
      // Dated its last play: where it ended, not how long ago it began.
      out.hasEstimated = true;
      last = Math.max(last, start);
      continue;
    }
    const end = start + s.seconds * 1000;
    last = Math.max(last, end);
    out.launches += 1;
    out.longestSeconds = Math.max(out.longestSeconds, s.seconds);
    out.weekSeconds += since(start, end, week);
    out.monthSeconds += since(start, end, month);
  }
  out.weekSeconds = Math.round(out.weekSeconds);
  out.monthSeconds = Math.round(out.monthSeconds);
  out.firstPlayed = Number.isFinite(first) ? new Date(first).toISOString() : null;
  out.lastPlayed = Number.isFinite(last) ? new Date(last).toISOString() : null;
  return out;
}
