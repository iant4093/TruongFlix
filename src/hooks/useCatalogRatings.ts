import { useEffect, useState } from 'react';
import { cachedTitleRating } from '../services/imdb';
import { cachedCriticScores, type CriticScores } from '../services/omdb';
import { useLibraryStore } from '../store/useLibraryStore';
import type { MediaItem } from '../types/media';

export default function useCatalogRatings(imdbId: string | null | undefined, owned?: MediaItem) {
  const imdbEnabled = useLibraryStore((s) => s.settings.imdb_enabled);
  const imdbSync = useLibraryStore((s) => s.settings.imdb_last_sync);
  const omdbKey = useLibraryStore((s) => s.settings.omdb_api_key);
  const [imdb, setImdb] = useState<{ id: string; rating: number; votes: number } | null>(null);
  const [critics, setCritics] = useState<{ id: string; key: string; scores: CriticScores } | null>(null);
  const hasOwnedCritics = owned?.rtScore != null || owned?.metacritic != null;

  useEffect(() => {
    if (!imdbEnabled || !imdbId || owned?.imdbRating != null) return;
    let alive = true;
    void cachedTitleRating(imdbId).then((rating) => {
      if (alive) setImdb(rating ? { id: imdbId, ...rating } : null);
    }).catch(() => {});
    return () => { alive = false; };
  }, [imdbEnabled, imdbId, imdbSync, owned?.imdbRating]);

  useEffect(() => {
    if (!omdbKey || !imdbId || hasOwnedCritics) return;
    let alive = true;
    void cachedCriticScores(omdbKey, imdbId).then((scores) => {
      if (alive) setCritics({ id: imdbId, key: omdbKey, scores });
    }).catch(() => {});
    return () => { alive = false; };
  }, [omdbKey, imdbId, hasOwnedCritics]);

  const rating = imdb?.id === imdbId ? imdb : null;
  const scores = critics && critics.id === imdbId && critics.key === omdbKey ? critics.scores : null;
  return {
    imdbRating: imdbEnabled ? owned?.imdbRating ?? rating?.rating ?? null : null,
    imdbVotes: owned?.imdbVotes ?? rating?.votes ?? null,
    rtScore: owned?.rtScore ?? scores?.rt ?? null,
    metacritic: owned?.metacritic ?? scores?.metacritic ?? null,
  };
}
