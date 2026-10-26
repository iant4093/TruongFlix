/** Rotten Tomatoes and Metacritic scores from OMDb (free key, 1,000 requests a day). */

export class OmdbError extends Error {
  constructor(
    message: string,
    public kind: 'key' | 'limit' | 'network' | 'other',
  ) {
    super(message);
  }
}

export interface CriticScores {
  rt: number | null;
  metacritic: number | null;
}

interface OmdbResponse {
  Response: 'True' | 'False';
  Error?: string;
  Ratings?: { Source: string; Value: string }[];
  Metascore?: string;
}

export async function fetchCriticScores(apiKey: string, imdbId: string): Promise<CriticScores> {
  let res: Response;
  try {
    res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`);
  } catch {
    throw new OmdbError('Couldn’t reach OMDb', 'network');
  }
  const data = (await res.json().catch(() => null)) as OmdbResponse | null;
  if (!data) throw new OmdbError(`OMDb answered HTTP ${res.status}`, 'other');
  if (data.Response === 'False') {
    const msg = data.Error ?? 'Unknown error';
    if (/invalid api key|no api key/i.test(msg) || res.status === 401) throw new OmdbError('The OMDb key isn’t valid', 'key');
    if (/limit/i.test(msg)) throw new OmdbError('OMDb’s daily limit was reached', 'limit');
    if (/not found/i.test(msg)) return { rt: null, metacritic: null };
    throw new OmdbError(msg, 'other');
  }
  const rt = data.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value;
  const meta = data.Metascore && data.Metascore !== 'N/A' ? data.Metascore : data.Ratings?.find((r) => r.Source === 'Metacritic')?.Value;
  const num = (v: string | undefined) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return { rt: num(rt), metacritic: num(meta) };
}

/** Checks a key against a title that certainly exists (The Matrix). */
export async function verifyOmdbKey(apiKey: string): Promise<boolean> {
  try {
    const s = await fetchCriticScores(apiKey, 'tt0133093');
    return s.rt != null || s.metacritic != null;
  } catch (e) {
    if (e instanceof OmdbError && e.kind === 'key') return false;
    throw e;
  }
}
