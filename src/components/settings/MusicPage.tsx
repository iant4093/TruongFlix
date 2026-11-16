import { useEffect } from 'react';
import { DatabaseZap, Music, RefreshCw } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runMusicScan, useMusicScan } from '../../services/music';
import { loadMusicLibrary } from '../../music/actions';
import { useMusicPlayer } from '../../music/player';
import { FolderList } from '../common/SetupControls';
import { Block, BTN, BTN_PRIMARY, Group, Page, Row, ToggleRow } from './ui';
import { closeSettingsAnd } from './nav';

/** Music folders, lyrics and the music library's own scan. */
export default function MusicPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const scanning = useMusicScan((s) => s.running);
  const library = useMusicPlayer((s) => s.library);
  useEffect(() => void loadMusicLibrary(), []);

  const counts: [string, number | null][] = [
    ['Songs', library?.tracks.length ?? null],
    ['Albums', library?.albums.length ?? null],
    ['Artists', library?.artists.length ?? null],
    ['Playlists', library?.playlists.length ?? null],
  ];
  const overlap = settings.music_directories.filter((m) =>
    settings.media_directories.some((d) => {
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return norm(m) === norm(d) || norm(m).startsWith(`${norm(d)}/`);
    }),
  );

  return (
    <Page title="Music" description="Where your music lives. Songs are matched from their tags, file names and folders; no account or online service is needed.">
      <Group
        title="Music folders"
        footer="MP3, FLAC, AAC/ALAC (.m4a), Ogg, Opus and WAV. Tags, covers and lyrics (embedded or a matching .lrc file) are read when you scan. Music folders are kept out of Movies & TV, even inside a movie or TV folder."
      >
        <Block>
          <FolderList
            value={settings.music_directories}
            onChange={(dirs) => void updateSettings({ music_directories: dirs }).then(() => runMusicScan())}
            pickerTitle="Choose music folders"
            emptyText="No music folders yet. Add the folders containing your music."
          />
        </Block>
        {overlap.length > 0 && (
          <Block className="text-xs text-nf-secondary">
            {overlap.length === 1 ? 'This music folder is' : 'These music folders are'} inside a movie or TV folder; Movies & TV skips {overlap.length === 1 ? 'it' : 'them'}.
          </Block>
        )}
      </Group>

      <Group title="Your music">
        <Block className="grid grid-cols-4 gap-2 text-center">
          {counts.map(([label, n]) => (
            <div key={label} className="rounded-md bg-black/30 py-3">
              <div className="text-2xl font-bold tabular-nums">{n ?? '–'}</div>
              <div className="text-xs text-nf-muted">{label}</div>
            </div>
          ))}
        </Block>
        <Row label="Scan for changes" description="Finds new, changed and removed songs. New downloads also show up on their own while folder watching is on (Library).">
          <button onClick={() => void runMusicScan()} disabled={scanning || !settings.music_directories.length} className={BTN_PRIMARY}>
            <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> Scan now
          </button>
        </Row>
        <Row label="Match all songs again" description="Reads every song's tags, cover and lyrics again and regroups albums and artists. Plays, favourites and playlists are kept.">
          <button onClick={() => void runMusicScan({ force: true })} disabled={scanning || !settings.music_directories.length} className={BTN}>
            <DatabaseZap className="h-4 w-4" /> Rematch
          </button>
        </Row>
        <Row label="Open Music" description="Albums, artists, songs and playlists.">
          <button onClick={() => closeSettingsAnd(() => useLibraryStore.getState().setView('music'))} className={BTN}>
            <Music className="h-4 w-4" /> Open
          </button>
        </Row>
      </Group>

      <Group title="Lyrics">
        <ToggleRow
          label="Find synced lyrics online"
          description="Songs without lyrics of their own are looked up once on LRCLIB (lrclib.net). Only the artist, title, album and length are sent."
          checked={settings.music_lyrics_online}
          onChange={(v) => void updateSettings({ music_lyrics_online: v })}
        />
      </Group>
    </Page>
  );
}
