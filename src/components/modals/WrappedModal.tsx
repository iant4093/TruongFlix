import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, Disc3, Flame, Gamepad2, Headphones, Moon, Music, Popcorn, Repeat1, Sparkles, Sun, Sunrise, Sunset, Timer, Tv, Zap } from 'lucide-react';
import type { WatchLogRow } from '../../types/media';
import type { MusicPlayRow } from '../../services/musicdb';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useMusicPlayer } from '../../music/player';
import { FullScreenOverlay, OverlayCloseButton } from '../common/Dialog';
import { listWatchLog } from '../../services/db';
import {
  computeGameWrapped,
  computeMusicWrapped,
  computeWrapped,
  formatHours,
  formatMinutes,
  logYears,
  playYears,
  profileSessions,
  sessionYears,
  type DayPart,
  type GameSessionRow,
  type GameWrappedStats,
  type MusicWrappedStats,
  type Streak,
  type WrappedStats,
} from '../../services/wrapped';
import Dropdown from '../common/Dropdown';
import ProfileAvatar from '../common/ProfileAvatar';

// Game artwork comes through the games image cache; only Windows builds include games.
const GameCover = __GAMES__ ? lazy(() => import('../../games/components/GameCover')) : null;

/** Game sessions are recorded on this PC; each notes the profile that started the game. */
function loadGameSessions(): Promise<GameSessionRow[]> {
  if (!__GAMES__) return Promise.resolve([]);
  return import('../../games/library').then((m) => m.listPlaySessions()).catch(() => []);
}

/** This profile's music plays (none when Music has never been used). */
function loadMusicPlays(profileId: number): Promise<MusicPlayRow[]> {
  return import('../../services/musicdb').then((m) => m.listMusicPlays(profileId)).catch(() => []);
}

const hoursLabel = (seconds: number) => `${formatHours(seconds)}${seconds >= 3600 ? ' hours' : ''}`;
const minutesLabel = (seconds: number) => `${formatMinutes(seconds)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}`;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
const streakDates = (s: Streak) => (s.days > 1 ? `${fmtDay(s.from)} – ${fmtDay(s.to)}` : fmtDay(s.from));

const DAY_PARTS: Record<DayPart, { music: string; games: string; when: string; icon: ReactNode }> = {
  morning: { music: 'Early bird', games: 'Morning player', when: 'in the morning', icon: <Sunrise className="h-5 w-5" /> },
  afternoon: { music: 'Afternoon listener', games: 'Afternoon player', when: 'in the afternoon', icon: <Sun className="h-5 w-5" /> },
  evening: { music: 'Evening listener', games: 'Evening player', when: 'in the evening', icon: <Sunset className="h-5 w-5" /> },
  night: { music: 'Night owl', games: 'Night owl', when: 'late at night', icon: <Moon className="h-5 w-5" /> },
};

/** Tile widths in the 6-column grid: one fills the row, two halve it, three take a third each. */
const TILE_SPAN = ['col-span-6', 'col-span-6', 'col-span-3', 'col-span-2'];

/**
 * Half-width cards that pair up two per row; an odd one out fills its row. Cards whose stat is
 * missing are passed as null and leave no gap.
 */
function Pairs({ cards }: { cards: (((span: string) => ReactNode) | null | false)[] }) {
  const shown = cards.filter((c): c is (span: string) => ReactNode => !!c);
  return <>{shown.map((card, i) => card(shown.length % 2 === 1 && i === shown.length - 1 ? 'col-span-6' : 'col-span-3'))}</>;
}

function Card({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.21, 0, 0.27, 1] }}
      className={`overflow-hidden rounded-2xl p-7 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function SectionTitle({ id, icon, children, badge }: { id: string; icon: ReactNode; children: ReactNode; badge?: string }) {
  return (
    <div className="mb-5 flex items-baseline gap-3">
      <h2 id={id} className="flex items-center gap-2 text-2xl font-black">{icon}{children}</h2>
      {badge && <span className="rounded border border-white/25 px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-nf-secondary">{badge}</span>}
    </div>
  );
}

function GenreBars({ genres, bar, delay, span, label }: { genres: { name: string; seconds: number }[]; bar: string; delay: number; span: string; label: string }) {
  return (
    <Card key={label} delay={delay} className={`${span} bg-white/[0.06] ring-1 ring-white/10`}>
      <h3 className="mb-1 text-sm uppercase tracking-widest text-nf-secondary">{label}</h3>
      <div className="mb-5 text-3xl font-black">{genres[0].name}</div>
      <div className="space-y-3">
        {genres.map((g, i) => (
          <div key={g.name}>
            <div className="mb-1 flex justify-between text-sm">
              <span className={i === 0 ? 'font-semibold' : 'text-nf-secondary'}>{g.name}</span>
              <span className="tabular-nums text-nf-muted">{formatHours(g.seconds)}{g.seconds >= 3600 ? 'h' : ''}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(g.seconds / genres[0].seconds) * 100}%` }}
                transition={{ duration: 0.9, delay: delay + 0.1 + i * 0.08 }}
                className={`h-full rounded-full ${bar}`}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MonthChart({ months, delay, peak, label = 'Month by month' }: { months: number[]; delay: number; peak: string; label?: string }) {
  const max = Math.max(1, ...months);
  return (
    <Card delay={delay} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
      <h3 className="mb-6 text-sm uppercase tracking-widest text-nf-secondary">{label}</h3>
      <div className="flex h-40 items-end gap-3">
        {months.map((s, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${(s / max) * 100}%` }}
              transition={{ duration: 0.8, delay: delay + 0.06 + i * 0.04 }}
              title={hoursLabel(s)}
              className={`w-full rounded-t-md ${s === max ? peak : 'bg-white/25'}`}
            />
            <span className="text-xs text-nf-muted">{MONTHS[i]}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StreakCard({ streak, delay, span, note }: { streak: Streak; delay: number; span: string; note?: string }) {
  return (
    <Card key="streak" delay={delay} className={`${span} bg-gradient-to-br from-[#2E86DE]/35 to-[#1ABC9C]/10 ring-1 ring-white/10`}>
      <h3 className="text-sm uppercase tracking-widest text-[#8fd3ff]">Longest streak</h3>
      <div className="mt-3 text-6xl font-black">{plural(streak.days, 'day')}</div>
      <div className="mt-2 text-lg">
        {streakDates(streak)}
        {note && <span className="text-nf-secondary"> · {note}</span>}
      </div>
    </Card>
  );
}

function DayPartCard({ part, share, kind, delay, span }: { part: DayPart; share: number; kind: 'music' | 'games'; delay: number; span: string }) {
  const p = DAY_PARTS[part];
  return (
    <Card key="daypart" delay={delay} className={`${span} bg-gradient-to-br from-[#34495E]/60 to-[#8E44AD]/15 ring-1 ring-white/10`}>
      <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#c9b8ff]">{p.icon} Your time of day</div>
      <div className="mt-3 text-5xl font-black">{p[kind]}</div>
      <div className="mt-2 text-lg">
        {Math.round(share * 100)}% of your {kind === 'music' ? 'listening' : 'play time'} happened {p.when}
      </div>
    </Card>
  );
}

function GameArt({ cover, title, className }: { cover: string | null; title: string; className: string }) {
  if (!GameCover) return <div className={`bg-white/10 ${className}`} />;
  return (
    <Suspense fallback={<div className={`bg-white/10 ${className}`} />}>
      <GameCover url={cover} title={title} className={className} />
    </Suspense>
  );
}

/** A music cover, or a plain tile when the song has none. */
function Cover({ art, className, round = false }: { art: string | null; className: string; round?: boolean }) {
  const api = useMusicPlayer((s) => s.api);
  const url = api?.artUrl(art) ?? null;
  const shape = round ? 'rounded-full' : 'rounded-lg';
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-white/15 to-white/5 ${shape} ${className}`}>
        <Music className="h-1/3 w-1/3 text-white/40" />
      </div>
    );
  }
  return <img src={url} alt="" className={`object-cover ${shape} ${className}`} />;
}

const Rank = ({ n, size = 'text-4xl' }: { n: number; size?: string }) => (
  <span className={`absolute left-2 top-1 ${size} font-black text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]`}>{n}</span>
);

/** Movies and TV from the viewing history. */
function WatchWrapped({ stats, year, titled }: { stats: WrappedStats; year: number; titled: boolean }) {
  const topDay = stats.weekdays.indexOf(Math.max(...stats.weekdays));
  const tiles = [
    { label: 'Movies', value: stats.movies, icon: <Popcorn className="h-6 w-6" />, color: 'from-[#2E86DE]/40 to-[#2E86DE]/5' },
    { label: 'Episodes', value: stats.episodes, icon: <Tv className="h-6 w-6" />, color: 'from-[#8E44AD]/40 to-[#8E44AD]/5' },
    { label: 'Shows', value: stats.shows, icon: <Zap className="h-6 w-6" />, color: 'from-[#1ABC9C]/40 to-[#1ABC9C]/5' },
  ].filter((t) => t.value > 0);
  const topShow = stats.topShows[0];
  const streak = stats.longestStreak && stats.longestStreak.days >= 2 ? stats.longestStreak : null;
  return (
    <section aria-labelledby={titled ? 'wrapped-watch' : undefined}>
      {titled && <SectionTitle id="wrapped-watch" icon={<Popcorn className="h-6 w-6" />}>Movies &amp; TV</SectionTitle>}
      <div className="grid grid-cols-6 gap-5">
        <Card className="col-span-6 bg-gradient-to-br from-nf-red via-[#b20710] to-[#3d0205]">
          <div className="text-lg font-semibold text-white/80">In {year} you watched</div>
          <div className="mt-1 flex items-baseline gap-4">
            <span className="text-[clamp(4rem,10vw,8rem)] font-black leading-none tracking-tight">{formatHours(stats.seconds)}</span>
            <span className="text-3xl font-bold">{stats.seconds >= 3600 ? 'hours' : ''}</span>
          </div>
          <div className="mt-3 text-lg text-white/85">
            across {plural(stats.days, 'day')}
            {stats.seconds >= 86400 ? ` — that’s ${(stats.seconds / 86400).toFixed(1)} days of nonstop TruongFlix.` : '.'}
          </div>
        </Card>

        {tiles.map((t, i) => (
          <Card key={t.label} delay={0.08 + i * 0.06} className={`${TILE_SPAN[tiles.length]} bg-gradient-to-br ${t.color} ring-1 ring-white/10`}>
            <div className="flex items-center gap-2 text-nf-secondary">
              {t.icon} {t.label}
            </div>
            <div className="mt-2 text-6xl font-black">{t.value}</div>
          </Card>
        ))}

        <Pairs
          cards={[
            stats.topGenres.length > 0 && ((span) => <GenreBars key="genres" genres={stats.topGenres} bar="bg-nf-red" delay={0.2} span={span} label="Top genres" />),
            !!topShow && ((span) => (
              <Card key="show" delay={0.26} className={`${span} flex gap-5 bg-white/[0.06] ring-1 ring-white/10`}>
                {topShow.poster && <img src={topShow.poster} alt="" className="h-48 w-32 shrink-0 rounded-lg object-cover shadow-xl" />}
                <div className="min-w-0">
                  <h3 className="text-sm uppercase tracking-widest text-nf-secondary">Your top show</h3>
                  <div className="mt-1 text-3xl font-black leading-tight">{topShow.title}</div>
                  <div className="mt-2 text-nf-secondary">
                    {plural(topShow.episodes, 'episode')} · {hoursLabel(topShow.seconds)}
                  </div>
                  <ol className="mt-4 space-y-1 text-sm text-nf-secondary">
                    {stats.topShows.slice(1).map((s, i) => (
                      <li key={s.id} className="truncate">
                        <span className="mr-2 font-bold text-white/60">{i + 2}</span>
                        {s.title}
                      </li>
                    ))}
                  </ol>
                </div>
              </Card>
            )),
          ]}
        />

        <Pairs
          cards={[
            !!stats.binge && ((span) => (
              <Card key="binge" delay={0.32} className={`${span} bg-gradient-to-br from-[#F5B70A]/35 to-[#E67E22]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-nf-gold">
                  <Flame className="h-5 w-5" /> Biggest binge
                </div>
                <div className="mt-3 text-6xl font-black">{stats.binge!.episodes} episodes</div>
                <div className="mt-2 text-lg">
                  of <span className="font-bold">{stats.binge!.title}</span> on {fmtDay(stats.binge!.day)}
                </div>
              </Card>
            )),
            !!streak && ((span) => <StreakCard key="streak" streak={streak!} delay={0.38} span={span} note={`you watch most on ${WEEKDAYS[topDay]}s`} />),
          ]}
        />

        <MonthChart months={stats.months} delay={0.44} peak="bg-nf-red" />

        {stats.topMovies.length > 0 && (
          <Card delay={0.5} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
            <h3 className="mb-5 text-sm uppercase tracking-widest text-nf-secondary">Top movies</h3>
            <div className="grid grid-cols-5 gap-4">
              {stats.topMovies.map((m, i) => (
                <div key={m.id}>
                  <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-white/10">
                    {m.poster && <img src={m.poster} alt="" className="h-full w-full object-cover" />}
                    <Rank n={i + 1} />
                  </div>
                  <div className="mt-2 truncate text-sm font-semibold">{m.title}</div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}

/** This profile's listening, from its music plays. */
export function MusicWrapped({ stats, year }: { stats: MusicWrappedStats; year: number }) {
  const [artist, ...moreArtists] = stats.topArtists;
  const albums = stats.topAlbums.length >= 2 ? stats.topAlbums : [];
  const summary = [plural(stats.plays, 'play'), plural(stats.songs, 'song'), plural(stats.artists, 'artist')].join(' · ');
  return (
    <section aria-labelledby="wrapped-music">
      <SectionTitle id="wrapped-music" icon={<Music className="h-6 w-6" />}>Music</SectionTitle>
      <div className="grid grid-cols-6 gap-5">
        <Card delay={0.05} className="col-span-6 bg-gradient-to-br from-[#d6246e] via-[#7b1fa2] to-[#1c0630] ring-1 ring-white/10">
          <div className="text-lg font-semibold text-white/80">In {year} you listened to</div>
          <div className="mt-1 flex items-baseline gap-4">
            <span className="text-[clamp(3.5rem,8vw,6.5rem)] font-black leading-none tracking-tight">{formatMinutes(stats.seconds)}</span>
            <span className="text-3xl font-bold">minute{Math.round(stats.seconds / 60) === 1 ? '' : 's'} of music</span>
          </div>
          <div className="mt-3 text-lg text-white/85">
            {summary}, across {plural(stats.days, 'day')}
            {stats.seconds >= 86400 ? ` — ${(stats.seconds / 86400).toFixed(1)} days of nonstop sound.` : '.'}
          </div>
        </Card>

        <Pairs
          cards={[
            !!artist && ((span) => (
              <Card key="artist" delay={0.12} className={`${span} bg-white/[0.06] ring-1 ring-white/10`}>
                <h3 className="text-sm uppercase tracking-widest text-nf-secondary">{moreArtists.length ? 'Top artists' : 'Your artist of the year'}</h3>
                <div className="mt-4 flex items-center gap-5">
                  <Cover art={artist.art} round className="h-32 w-32 shrink-0 shadow-xl" />
                  <div className="min-w-0">
                    <div className="text-3xl font-black leading-tight">{artist.name}</div>
                    <div className="mt-2 text-nf-secondary">
                      {minutesLabel(artist.seconds)} · {plural(artist.songs, 'song')}
                    </div>
                  </div>
                </div>
                {moreArtists.length > 0 && (
                  <ol className="mt-5 space-y-1 text-sm text-nf-secondary">
                    {moreArtists.map((a, i) => (
                      <li key={a.key} className="flex justify-between gap-3">
                        <span className="truncate"><span className="mr-2 font-bold text-white/60">{i + 2}</span>{a.name}</span>
                        <span className="shrink-0 tabular-nums text-nf-muted">{formatMinutes(a.seconds)} min</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            )),
            stats.topSongs.length > 0 && ((span) => (
              <Card key="songs" delay={0.18} className={`${span} bg-white/[0.06] ring-1 ring-white/10`}>
                <h3 className="mb-4 text-sm uppercase tracking-widest text-nf-secondary">{stats.topSongs.length > 1 ? 'Top songs' : 'Your song of the year'}</h3>
                <ol className="space-y-3">
                  {stats.topSongs.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-3">
                      <span className={`w-5 shrink-0 text-right font-black ${i === 0 ? 'text-2xl text-white' : 'text-white/60'}`}>{i + 1}</span>
                      <Cover art={s.art} className={`${i === 0 ? 'h-16 w-16' : 'h-11 w-11'} shrink-0`} />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate font-semibold ${i === 0 ? 'text-lg' : 'text-sm'}`}>{s.title}</div>
                        <div className="truncate text-xs text-nf-muted">{s.artist}</div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-nf-secondary">{plural(s.plays, 'play')}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            )),
          ]}
        />

        {albums.length > 0 && (
          <Card delay={0.24} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
            <h3 className="mb-5 flex items-center gap-2 text-sm uppercase tracking-widest text-nf-secondary"><Disc3 className="h-4 w-4" /> Top albums</h3>
            <div className="grid grid-cols-5 gap-4">
              {albums.map((a, i) => (
                <div key={a.id} className="min-w-0">
                  <div className="relative">
                    <Cover art={a.art} className="aspect-square w-full" />
                    <Rank n={i + 1} />
                  </div>
                  <div className="mt-2 truncate text-sm font-semibold">{a.title}</div>
                  <div className="truncate text-xs text-nf-muted">{a.artist} · {plural(a.plays, 'play')}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Pairs
          cards={[
            stats.topGenres.length > 0 && ((span) => <GenreBars key="genres" genres={stats.topGenres} bar="bg-[#e0457b]" delay={0.3} span={span} label="Top genres" />),
            !!stats.onRepeat && ((span) => (
              <Card key="repeat" delay={0.34} className={`${span} bg-gradient-to-br from-[#F5B70A]/35 to-[#E67E22]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-nf-gold"><Repeat1 className="h-5 w-5" /> On repeat</div>
                <div className="mt-4 flex items-center gap-5">
                  <Cover art={stats.onRepeat!.art} className="h-24 w-24 shrink-0 shadow-xl" />
                  <div className="min-w-0">
                    <div className="text-5xl font-black">{stats.onRepeat!.plays} times</div>
                    <div className="mt-2 text-lg">
                      <span className="font-bold">{stats.onRepeat!.title}</span> on {fmtDay(stats.onRepeat!.day)}
                    </div>
                  </div>
                </div>
              </Card>
            )),
            !!stats.longestStreak && ((span) => <StreakCard key="streak" streak={stats.longestStreak!} delay={0.38} span={span} note="music every day" />),
            !!stats.timeOfDay && ((span) => <DayPartCard key="daypart" {...stats.timeOfDay!} kind="music" delay={0.42} span={span} />),
            !!stats.firstSong && ((span) => (
              <Card key="first" delay={0.46} className={`${span} bg-gradient-to-br from-[#1ABC9C]/30 to-[#2E86DE]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#8ff0d8]"><Sparkles className="h-5 w-5" /> First song of {year}</div>
                <div className="mt-4 flex items-center gap-5">
                  <Cover art={stats.firstSong!.art} className="h-24 w-24 shrink-0 shadow-xl" />
                  <div className="min-w-0">
                    <div className="truncate text-3xl font-black leading-tight">{stats.firstSong!.title}</div>
                    <div className="mt-1 truncate text-lg">{stats.firstSong!.artist}</div>
                    <div className="mt-1 text-sm text-nf-secondary">{fmtDay(stats.firstSong!.day)}</div>
                  </div>
                </div>
              </Card>
            )),
            !!stats.busiestDay && ((span) => (
              <Card key="busiest" delay={0.5} className={`${span} bg-gradient-to-br from-[#d6246e]/30 to-[#7b1fa2]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#ffb3d1]"><Headphones className="h-5 w-5" /> Biggest listening day</div>
                <div className="mt-3 text-6xl font-black">{fmtDay(stats.busiestDay!.day)}</div>
                <div className="mt-2 text-lg">{minutesLabel(stats.busiestDay!.seconds)} · {plural(stats.busiestDay!.plays, 'play')}</div>
              </Card>
            )),
          ]}
        />

        {stats.months && <MonthChart months={stats.months} delay={0.54} peak="bg-[#e0457b]" />}
      </div>
    </section>
  );
}

/** Play time from games on this PC (Windows). */
export function GamesWrapped({ stats, year }: { stats: GameWrappedStats; year: number }) {
  const [top, ...rest] = stats.topGames;
  return (
    <section aria-labelledby="wrapped-games">
      <SectionTitle id="wrapped-games" icon={<Gamepad2 className="h-6 w-6" />} badge={stats.shared ? 'On this PC' : undefined}>Games</SectionTitle>
      <div className="grid grid-cols-6 gap-5">
        <Card delay={0.1} className="col-span-6 bg-gradient-to-br from-[#1f6f4a] via-[#124a33] to-[#06170f] ring-1 ring-white/10">
          <div className="text-lg font-semibold text-white/80">In {year} you played</div>
          <div className="mt-1 flex items-baseline gap-4">
            <span className="text-[clamp(3.5rem,8vw,6.5rem)] font-black leading-none tracking-tight">{formatHours(stats.seconds)}</span>
            <span className="text-3xl font-bold">{stats.seconds >= 3600 ? 'hours of games' : 'of games'}</span>
          </div>
          <div className="mt-3 text-lg text-white/85">
            {plural(stats.games, 'game')}
            {stats.sessions > 0 && ` across ${plural(stats.sessions, 'session')}`}
            {stats.days > 1 && ` on ${plural(stats.days, 'day')}`}
            {stats.averageSession != null && ` — ${hoursLabel(stats.averageSession)} a session on average`}.
          </div>
        </Card>

        {top && (
          <Card delay={0.18} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
            <h3 className="mb-5 text-sm uppercase tracking-widest text-nf-secondary">{rest.length ? 'Most played' : 'Your game of the year'}</h3>
            <div className="flex gap-6">
              <div className="relative w-52 shrink-0">
                <GameArt cover={top.cover} title={top.title} className="aspect-[2/3] w-full rounded-lg shadow-xl" />
                <Rank n={1} size="text-5xl" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-3xl font-black leading-tight">{top.title}</div>
                <div className="mt-2 text-nf-secondary">
                  {hoursLabel(top.seconds)}{top.sessions > 0 && ` · ${plural(top.sessions, 'session')}`}
                </div>
                {rest.length > 0 && (
                  <div className="mt-6 grid max-w-xl grid-cols-4 gap-4">
                    {rest.map((g, i) => (
                      <div key={g.slug} className="min-w-0">
                        <div className="relative">
                          <GameArt cover={g.cover} title={g.title} className="aspect-[2/3] w-full rounded-lg" />
                          <Rank n={i + 2} size="text-3xl" />
                        </div>
                        <div className="mt-2 truncate text-sm font-semibold">{g.title}</div>
                        <div className="text-xs text-nf-muted">{hoursLabel(g.seconds)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}

        <Pairs
          cards={[
            !!stats.longestSession && ((span) => (
              <Card key="longest" delay={0.26} className={`${span} bg-gradient-to-br from-[#8E44AD]/35 to-[#2E86DE]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#d7b8ff]"><Timer className="h-5 w-5" /> Longest session</div>
                <div className="mt-3 text-6xl font-black">{hoursLabel(stats.longestSession!.seconds)}</div>
                <div className="mt-2 text-lg">
                  of <span className="font-bold">{stats.longestSession!.title}</span> on {fmtDay(stats.longestSession!.day)}
                </div>
              </Card>
            )),
            !!stats.busiestDay && ((span) => (
              <Card key="busiest" delay={0.32} className={`${span} bg-gradient-to-br from-[#F5B70A]/30 to-[#E67E22]/10 ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-nf-gold"><CalendarDays className="h-5 w-5" /> Biggest gaming day</div>
                <div className="mt-3 text-6xl font-black">{fmtDay(stats.busiestDay!.day)}</div>
                <div className="mt-2 text-lg">{hoursLabel(stats.busiestDay!.seconds)} played</div>
              </Card>
            )),
            stats.topGenres.length > 0 && ((span) => <GenreBars key="genres" genres={stats.topGenres} bar="bg-[#2ecc71]" delay={0.36} span={span} label="Top genres" />),
            !!stats.longestStreak && ((span) => <StreakCard key="streak" streak={stats.longestStreak!} delay={0.4} span={span} note="gaming every day" />),
            !!stats.timeOfDay && ((span) => <DayPartCard key="daypart" {...stats.timeOfDay!} kind="games" delay={0.44} span={span} />),
          ]}
        />

        {stats.months && <MonthChart months={stats.months} delay={0.48} peak="bg-[#2ecc71]" />}
      </div>
    </section>
  );
}

/** Yearly stats from the viewing history, music plays and game sessions, Spotify-Wrapped style. */
export default function WrappedModal() {
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const profile = useLibraryStore((s) => s.activeProfile);
  const profileId = profile?.id ?? null;
  const [log, setLog] = useState<WatchLogRow[] | null>(null);
  const [plays, setPlays] = useState<MusicPlayRow[] | null>(null);
  const [sessions, setSessions] = useState<GameSessionRow[] | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const gamesAllowed = __GAMES__ && profile?.maturity === 'all';

  useEffect(() => {
    let active = true;
    setLog(null);
    setPlays(null);
    void listWatchLog().then((l) => active && setLog(l));
    if (profileId == null) setPlays([]);
    else void loadMusicPlays(profileId).then((p) => active && setPlays(p));
    return () => { active = false; };
  }, [profileId]);

  useEffect(() => {
    let active = true;
    setSessions(null);
    if (gamesAllowed && profileId != null) void loadGameSessions().then((s) => { if (active) setSessions(profileSessions(s, profileId)); });
    else setSessions([]);
    return () => { active = false; };
  }, [gamesAllowed, profileId]);

  const years = useMemo(() => {
    const ys = [...new Set([...logYears(log ?? []), ...playYears(plays ?? []), ...sessionYears(sessions ?? [])])].sort((a, b) => b - a);
    return ys.includes(year) ? ys : [year, ...ys];
  }, [log, plays, sessions, year]);
  const stats = useMemo(() => (log ? computeWrapped(log, year) : null), [log, year]);
  const musicStats = useMemo(() => (plays ? computeMusicWrapped(plays, year) : null), [plays, year]);
  const gameStats = useMemo(() => (gamesAllowed && sessions ? computeGameWrapped(sessions, year) : null), [gamesAllowed, sessions, year]);
  const loaded = !!log && !!plays && !!sessions;
  const watched = !!stats && stats.seconds >= 60;

  return (
    <FullScreenOverlay onClose={() => setOverlay(null)} label="TruongFlix Wrapped" priority={140} className="bg-black">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(229,9,20,0.28),transparent_60%)]" />
      <div className="relative mx-auto max-w-5xl px-8 pb-20 pt-10">
        <div className="mb-10 flex items-center gap-4">
          {profile && <ProfileAvatar color={profile.color} maturity={profile.maturity} size={40} />}
          <div className="flex-1">
            <div className="text-sm uppercase tracking-[0.3em] text-nf-secondary">{profile?.name ?? 'Your'}’s</div>
            <h1 className="nf-wordmark text-5xl">TruongFlix Wrapped</h1>
          </div>
          <Dropdown value={year} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={setYear} ariaLabel="Year" />
          <OverlayCloseButton onClose={() => setOverlay(null)} />
        </div>

        {!loaded ? null : !watched && !musicStats && !gameStats ? (
          <Card className="bg-white/5 text-center">
            <p className="text-2xl font-semibold">Nothing to wrap up for {year} yet.</p>
            <p className="mt-2 text-nf-secondary">Your Wrapped fills in as you watch and listen. Come back after a few movie nights.</p>
          </Card>
        ) : (
          <div key={year} className="space-y-12">
            {watched && <WatchWrapped stats={stats!} year={year} titled={!!musicStats || !!gameStats} />}
            {musicStats && <MusicWrapped stats={musicStats} year={year} />}
            {gameStats && <GamesWrapped stats={gameStats} year={year} />}
          </div>
        )}
      </div>
    </FullScreenOverlay>
  );
}
