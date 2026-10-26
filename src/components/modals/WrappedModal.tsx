import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Flame, Popcorn, Tv, X, Zap } from 'lucide-react';
import type { WatchLogRow } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { listWatchLog } from '../../services/db';
import { computeWrapped, formatHours, logYears } from '../../services/wrapped';
import Dropdown from '../common/Dropdown';
import ProfileAvatar from '../common/ProfileAvatar';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

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

/** Yearly stats from the viewing history, Spotify-Wrapped style. */
export default function WrappedModal() {
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const profile = useLibraryStore((s) => s.activeProfile);
  const [log, setLog] = useState<WatchLogRow[] | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    void listWatchLog().then(setLog);
  }, [profile?.id]);

  const years = useMemo(() => {
    const ys = logYears(log ?? []);
    return ys.includes(year) ? ys : [year, ...ys];
  }, [log, year]);
  const stats = useMemo(() => (log ? computeWrapped(log, year) : null), [log, year]);
  const maxMonth = stats ? Math.max(1, ...stats.months) : 1;
  const topDay = stats ? stats.weekdays.indexOf(Math.max(...stats.weekdays)) : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[140] overflow-y-auto bg-[#0b0b0b]"
    >
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(229,9,20,0.28),transparent_60%)]" />
      <div className="relative mx-auto max-w-5xl px-8 pb-20 pt-10">
        <div className="mb-10 flex items-center gap-4">
          {profile && <ProfileAvatar color={profile.color} maturity={profile.maturity} size={40} />}
          <div className="flex-1">
            <div className="text-sm uppercase tracking-[0.3em] text-nf-secondary">{profile?.name ?? 'Your'}’s</div>
            <h1 className="nf-wordmark text-5xl">TruongFlix Wrapped</h1>
          </div>
          <Dropdown value={year} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={setYear} ariaLabel="Year" />
          <button onClick={() => setOverlay(null)} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!stats ? null : stats.seconds < 60 ? (
          <Card className="bg-white/5 text-center">
            <p className="text-2xl font-semibold">Nothing watched in {year} yet.</p>
            <p className="mt-2 text-nf-secondary">Your Wrapped fills in as you watch. Come back after a few movie nights.</p>
          </Card>
        ) : (
          <div key={year} className="grid grid-cols-6 gap-5">
            <Card className="col-span-6 bg-gradient-to-br from-[#E50914] via-[#b20710] to-[#3d0205]">
              <div className="text-lg font-semibold text-white/80">In {year} you watched</div>
              <div className="mt-1 flex items-baseline gap-4">
                <span className="text-[clamp(4rem,10vw,8rem)] font-black leading-none tracking-tight">{formatHours(stats.seconds)}</span>
                <span className="text-3xl font-bold">{stats.seconds >= 3600 ? 'hours' : ''}</span>
              </div>
              <div className="mt-3 text-lg text-white/85">
                across {stats.days} day{stats.days === 1 ? '' : 's'}
                {stats.seconds >= 86400 ? ` — that’s ${(stats.seconds / 86400).toFixed(1)} days of nonstop TruongFlix.` : '.'}
              </div>
            </Card>

            {[
              { label: 'Movies', value: stats.movies, icon: <Popcorn className="h-6 w-6" />, color: 'from-[#2E86DE]/40 to-[#2E86DE]/5' },
              { label: 'Episodes', value: stats.episodes, icon: <Tv className="h-6 w-6" />, color: 'from-[#8E44AD]/40 to-[#8E44AD]/5' },
              { label: 'Shows', value: stats.shows, icon: <Zap className="h-6 w-6" />, color: 'from-[#1ABC9C]/40 to-[#1ABC9C]/5' },
            ].map((t, i) => (
              <Card key={t.label} delay={0.08 + i * 0.06} className={`col-span-2 bg-gradient-to-br ${t.color} ring-1 ring-white/10`}>
                <div className="flex items-center gap-2 text-nf-secondary">
                  {t.icon} {t.label}
                </div>
                <div className="mt-2 text-6xl font-black">{t.value}</div>
              </Card>
            ))}

            {stats.topGenres.length > 0 && (
              <Card delay={0.2} className="col-span-3 bg-white/[0.06] ring-1 ring-white/10">
                <h2 className="mb-1 text-sm uppercase tracking-widest text-nf-secondary">Top genres</h2>
                <div className="mb-5 text-3xl font-black">{stats.topGenres[0].name}</div>
                <div className="space-y-3">
                  {stats.topGenres.map((g, i) => (
                    <div key={g.name}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className={i === 0 ? 'font-semibold' : 'text-nf-secondary'}>{g.name}</span>
                        <span className="tabular-nums text-nf-muted">{formatHours(g.seconds)}{g.seconds >= 3600 ? 'h' : ''}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/10">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${(g.seconds / stats.topGenres[0].seconds) * 100}%` }}
                          transition={{ duration: 0.9, delay: 0.3 + i * 0.08 }}
                          className="h-full rounded-full bg-nf-red"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {stats.topShows[0] && (
              <Card delay={0.26} className="col-span-3 flex gap-5 bg-white/[0.06] ring-1 ring-white/10">
                {stats.topShows[0].poster && <img src={stats.topShows[0].poster} alt="" className="h-48 w-32 shrink-0 rounded-lg object-cover shadow-xl" />}
                <div className="min-w-0">
                  <h2 className="text-sm uppercase tracking-widest text-nf-secondary">Your top show</h2>
                  <div className="mt-1 text-3xl font-black leading-tight">{stats.topShows[0].title}</div>
                  <div className="mt-2 text-nf-secondary">
                    {stats.topShows[0].episodes} episode{stats.topShows[0].episodes === 1 ? '' : 's'} · {formatHours(stats.topShows[0].seconds)}
                    {stats.topShows[0].seconds >= 3600 ? ' hours' : ''}
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
            )}

            {stats.binge && (
              <Card delay={0.32} className="col-span-3 bg-gradient-to-br from-[#F5B70A]/35 to-[#E67E22]/10 ring-1 ring-white/10">
                <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#ffd76a]">
                  <Flame className="h-5 w-5" /> Biggest binge
                </div>
                <div className="mt-3 text-6xl font-black">{stats.binge.episodes} episodes</div>
                <div className="mt-2 text-lg">
                  of <span className="font-bold">{stats.binge.title}</span> on {fmtDay(stats.binge.day)}
                </div>
              </Card>
            )}

            {stats.longestStreak && (
              <Card delay={0.38} className={`${stats.binge ? 'col-span-3' : 'col-span-6'} bg-gradient-to-br from-[#2E86DE]/35 to-[#1ABC9C]/10 ring-1 ring-white/10`}>
                <h2 className="text-sm uppercase tracking-widest text-[#8fd3ff]">Longest streak</h2>
                <div className="mt-3 text-6xl font-black">
                  {stats.longestStreak.days} day{stats.longestStreak.days === 1 ? '' : 's'}
                </div>
                <div className="mt-2 text-lg">
                  {stats.longestStreak.days > 1 ? `${fmtDay(stats.longestStreak.from)} – ${fmtDay(stats.longestStreak.to)}` : fmtDay(stats.longestStreak.from)}
                  <span className="text-nf-secondary"> · you watch most on {WEEKDAYS[topDay]}s</span>
                </div>
              </Card>
            )}

            <Card delay={0.44} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
              <h2 className="mb-6 text-sm uppercase tracking-widest text-nf-secondary">Month by month</h2>
              <div className="flex h-40 items-end gap-3">
                {stats.months.map((s, i) => (
                  <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: `${(s / maxMonth) * 100}%` }}
                      transition={{ duration: 0.8, delay: 0.5 + i * 0.04 }}
                      title={`${formatHours(s)}${s >= 3600 ? ' hours' : ''}`}
                      className={`w-full rounded-t-md ${s === maxMonth ? 'bg-nf-red' : 'bg-white/25'}`}
                    />
                    <span className="text-xs text-nf-muted">{MONTHS[i]}</span>
                  </div>
                ))}
              </div>
            </Card>

            {stats.topMovies.length > 0 && (
              <Card delay={0.5} className="col-span-6 bg-white/[0.06] ring-1 ring-white/10">
                <h2 className="mb-5 text-sm uppercase tracking-widest text-nf-secondary">Top movies</h2>
                <div className="grid grid-cols-5 gap-4">
                  {stats.topMovies.map((m, i) => (
                    <div key={m.id}>
                      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-white/10">
                        {m.poster && <img src={m.poster} alt="" className="h-full w-full object-cover" />}
                        <span className="absolute left-2 top-1 text-4xl font-black text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">{i + 1}</span>
                      </div>
                      <div className="mt-2 truncate text-sm font-semibold">{m.title}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
