import { useMemo, useState } from 'react';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runImdbSync } from '../../services/scanner';
import { refreshCriticScores } from '../../services/enrich';
import { verifyOmdbKey } from '../../services/omdb';
import { TmdbKeyField } from '../common/SetupControls';
import { BTN, BTN_PRIMARY, Group, INPUT, Page, Row, StatusText, ToggleRow } from './ui';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function RatingsPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const scanning = useLibraryStore((s) => s.scan.running);
  const toast = useLibraryStore((s) => s.toast);
  const [tmdbKey, setTmdbKey] = useState(settings.tmdb_api_key);

  return (
    <Page title="Ratings & Data" description="Where titles, artwork and ratings come from.">
      <Group title="TMDB" footer="Required. Artwork, title logos, cast, episode details, age ratings and trailers come from The Movie Database.">
        <Row label="API key" stacked>
          <TmdbKeyField value={tmdbKey} onChange={setTmdbKey} />
          {tmdbKey.trim() !== settings.tmdb_api_key && (
            <button
              onClick={async () => {
                await updateSettings({ tmdb_api_key: tmdbKey.trim() });
                toast('TMDB API key saved', 'success');
              }}
              className={`${BTN_PRIMARY} mt-3`}
            >
              Save
            </button>
          )}
        </Row>
      </Group>

      <Group title="IMDb" footer="From IMDb’s official public datasets (about 65 MB, refreshed at most once a day when you scan). For personal, non-commercial use.">
        <ToggleRow
          label="Show IMDb ratings"
          description="For movies, shows, season averages and individual episodes."
          checked={settings.imdb_enabled}
          onChange={async (v) => {
            await updateSettings({ imdb_enabled: v });
            if (v) void runImdbSync();
          }}
        />
        {settings.imdb_enabled && (
          <Row label="Ratings data" description={settings.imdb_last_sync ? `Last updated ${when(settings.imdb_last_sync)}` : 'Not downloaded yet'}>
            <button onClick={() => runImdbSync({ force: true })} disabled={scanning} className={BTN}>
              <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </Row>
        )}
      </Group>

      <CriticScores />
    </Page>
  );
}

function CriticScores() {
  const saved = useLibraryStore((s) => s.settings.omdb_api_key);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const toast = useLibraryStore((s) => s.toast);
  const items = useLibraryStore((s) => s.allItems);
  const movies = useLibraryStore((s) => s.movies);
  const series = useLibraryStore((s) => s.series);
  const [key, setKey] = useState(saved);
  const [busy, setBusy] = useState<'saving' | 'refreshing' | null>(null);
  const [result, setResult] = useState<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null);

  const stats = useMemo(() => {
    const eligible = items.filter((i) => i.imdbId);
    const scored = eligible.filter((i) => i.rtScore != null || i.metacritic != null);
    const checked = [...movies.map((m) => m.omdb_at), ...series.map((s) => s.omdb_at)].filter(Boolean).sort().pop() ?? null;
    return {
      total: eligible.length,
      scored: scored.length,
      shows: eligible.filter((i) => i.kind === 'tv').length,
      showsScored: scored.filter((i) => i.kind === 'tv').length,
      checked,
    };
  }, [items, movies, series]);

  const refresh = async () => {
    setBusy('refreshing');
    setResult(null);
    const r = await refreshCriticScores();
    setBusy(null);
    if (r.error) setResult({ tone: 'bad', text: r.error });
    else if (!r.checked) setResult({ tone: 'warn', text: 'No titles with an IMDb ID to look up yet.' });
    else if (!r.found)
      setResult({
        tone: 'warn',
        text: `Checked ${r.checked} title${r.checked === 1 ? '' : 's'}: OMDb has no Rotten Tomatoes or Metacritic score for ${r.checked === 1 ? 'it' : 'them'}. This is common for TV shows.`,
      });
    else setResult({ tone: 'good', text: `Checked ${r.checked} title${r.checked === 1 ? '' : 's'}: scores found for ${r.found}.` });
  };

  const save = async () => {
    const k = key.trim();
    setBusy('saving');
    setResult(null);
    if (k) {
      const ok = await verifyOmdbKey(k).catch(() => null);
      if (ok === false) {
        setBusy(null);
        return setResult({ tone: 'bad', text: 'OMDb didn’t accept that key. Make sure you clicked the activation link OMDb emailed you.' });
      }
    }
    await updateSettings({ omdb_api_key: k });
    setBusy(null);
    if (k) {
      toast('OMDb key saved', 'success');
      await refresh();
    } else toast('Critic scores turned off', 'info');
  };

  return (
    <Group
      title="Rotten Tomatoes & Metacritic"
      footer={
        <>
          Critic scores come from OMDb, which mostly covers movies; many TV shows have no critic scores there.{' '}
          <button onClick={() => void openExternal('https://www.omdbapi.com/apikey.aspx')} className="inline-flex items-center gap-1 text-nf-secondary hover:text-white hover:underline">
            Get a free key <ExternalLink className="h-3 w-3" />
          </button>
        </>
      }
    >
      <Row label="OMDb API key" description="Free, 1,000 lookups a day. TruongFlix uses a fraction of that.">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" spellCheck={false} className={`${INPUT} w-52 font-mono`} />
        {key.trim() !== saved && (
          <button onClick={() => void save()} disabled={busy != null} className={BTN_PRIMARY}>
            {busy === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </button>
        )}
      </Row>
      {saved && (
        <Row
          label="Scores"
          description={
            <span className="space-y-1">
              <span className="block">
                {stats.scored} of {stats.total} title{stats.total === 1 ? '' : 's'} have critic scores
                {stats.shows > 0 && ` (${stats.showsScored} of ${stats.shows} shows)`}
                {stats.checked && ` · last checked ${when(stats.checked.replace(' ', 'T') + 'Z')}`}
              </span>
              {result && (
                <span className="block">
                  <StatusText tone={result.tone}>{result.text}</StatusText>
                </span>
              )}
            </span>
          }
        >
          <button onClick={() => void refresh()} disabled={busy != null} className={BTN}>
            <RefreshCw className={`h-4 w-4 ${busy === 'refreshing' ? 'animate-spin' : ''}`} /> Refresh scores
          </button>
        </Row>
      )}
    </Group>
  );
}
