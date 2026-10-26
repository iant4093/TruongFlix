import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { User, X } from 'lucide-react';
import type { MediaItem } from '../../types/media';
import { useLibraryStore, type ActorRef } from '../../store/useLibraryStore';
import { getPerson, resize, type PersonInfo } from '../../services/tmdb';
import { formatRuntime, matchPercent } from '../../store/selectors';
import Artwork from '../common/Artwork';
import MaturityRating from '../common/MaturityRating';

/** Everything in your library featuring one cast or crew member. */
export default function ActorModal() {
  const actor = useLibraryStore((s) => s.actor);
  return <AnimatePresence>{actor && <ActorPage key={actor.id ?? actor.name} actor={actor} />}</AnimatePresence>;
}

function ActorPage({ actor }: { actor: ActorRef }) {
  const items = useLibraryStore((s) => s.items);
  const openActor = useLibraryStore((s) => s.openActor);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const [person, setPerson] = useState<PersonInfo | null>(null);
  const [bioOpen, setBioOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getPerson({ id: actor.id, name: actor.name })
      .then((p) => alive && setPerson(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [actor.id, actor.name]);

  const credits = useMemo(() => {
    const name = actor.name.toLowerCase();
    const out: { item: MediaItem; role: string }[] = [];
    for (const item of items) {
      const hit = item.cast.find((c) => (actor.id && c.id ? c.id === actor.id : c.name.toLowerCase() === name));
      if (hit) out.push({ item, role: hit.job ?? (hit.character ? `as ${hit.character}` : '') });
    }
    return out.sort((a, b) => (b.item.year ?? 0) - (a.item.year ?? 0));
  }, [items, actor]);

  const photo = person?.profile ?? actor.profile ?? null;
  const born = person?.birthday
    ? new Date(`${person.birthday}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={(e) => e.target === e.currentTarget && openActor(null)}
      className="fixed inset-0 z-[70] flex justify-center overflow-y-auto bg-black/75 px-4 pb-10 pt-8 backdrop-blur-xs"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 24 }}
        transition={{ duration: 0.26, ease: [0.21, 0, 0.27, 1] }}
        className="relative h-max w-full max-w-4xl overflow-hidden rounded-xl bg-nf-surface shadow-2xl"
      >
        <button
          onClick={() => openActor(null)}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-[#2a2a2a]"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex gap-8 bg-gradient-to-b from-[#2b2b2b] to-nf-surface p-10 pb-6">
          <div className="h-56 w-40 shrink-0 overflow-hidden rounded-md bg-[#333] shadow-xl">
            {photo ? (
              <img src={photo} alt={actor.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-nf-muted">
                <User className="h-16 w-16" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3 pt-2">
            <h2 className="text-4xl font-black leading-tight">{person?.name ?? actor.name}</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-nf-secondary">
              {person?.known_for && <span>{person.known_for === 'Acting' ? 'Actor' : person.known_for}</span>}
              {born && <span>Born {born}</span>}
              {person?.place_of_birth && <span>{person.place_of_birth}</span>}
            </div>
            {person?.biography && (
              <div>
                <p className={`text-[15px] leading-relaxed text-[#d2d2d2] ${bioOpen ? '' : 'line-clamp-5'}`}>{person.biography}</p>
                {person.biography.length > 420 && (
                  <button onClick={() => setBioOpen(!bioOpen)} className="mt-1 text-sm font-semibold text-white hover:underline">
                    {bioOpen ? 'Less' : 'More'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <section className="px-10 pb-10">
          <h3 className="mb-5 text-2xl font-bold">
            In Your Library <span className="text-base font-normal text-nf-muted">· {credits.length} title{credits.length === 1 ? '' : 's'}</span>
          </h3>
          {credits.length ? (
            <div className="grid grid-cols-3 gap-4">
              {credits.map(({ item, role }) => {
                const m = matchPercent(item.voteAverage);
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      openActor(null);
                      openDetail(item.key);
                    }}
                    className="overflow-hidden rounded-md bg-[#2f2f2f] text-left transition-colors hover:bg-[#383838]"
                  >
                    <div className="relative aspect-video">
                      <Artwork src={resize(item.backdrop, 'w500')} alt={item.title} fallbackTitle={item.title} className="h-full w-full" />
                      <span className="text-shadow absolute bottom-2 left-2 line-clamp-1 max-w-[90%] text-sm font-bold">{item.title}</span>
                    </div>
                    <div className="space-y-1 p-3 text-sm">
                      <div className="flex items-center gap-2">
                        {m != null && <span className="font-semibold text-nf-green">{m}% Match</span>}
                        <MaturityRating rating={item.certification} />
                        <span className="text-nf-secondary">{item.year}</span>
                        <span className="text-nf-secondary">
                          {item.kind === 'movie' ? formatRuntime(item.runtime) : `${item.seasonCount} Season${item.seasonCount === 1 ? '' : 's'}`}
                        </span>
                      </div>
                      {role && <div className="truncate text-xs text-nf-muted">{role}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-nf-secondary">Nothing else with {actor.name} in your library yet.</p>
          )}
        </section>
      </motion.div>
    </motion.div>
  );
}
