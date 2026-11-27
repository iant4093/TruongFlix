import { useEffect, useState } from 'react';
import { DatabaseZap, LogIn, LogOut, Music, RefreshCw } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runMusicScan, useMusicScan } from '../../services/music';
import { loadMusicLibrary } from '../../music/actions';
import { useMusicPlayer } from '../../music/player';
import { FolderList } from '../common/SetupControls';
import { Block, BTN, BTN_PRIMARY, Group, INPUT, NumberField, Page, Row, Segmented, StatusText, ToggleRow } from './ui';
import Dropdown from '../common/Dropdown';
import { connectSoulseek, disconnectSoulseek, initMusicDownloads, useMusicDownloads } from '../../services/musicDownloads';
import { errorMessage } from '../../lib/errors';
import type { MusicQuality } from '../../types/media';
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

      <SoulseekSettings />

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

/** The Soulseek account Browse → Music downloads albums with, and how it downloads. */
function SoulseekSettings() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const status = useMusicDownloads((s) => s.status);
  const [username, setUsername] = useState(settings.soulseek_username);
  const [password, setPassword] = useState(settings.soulseek_password);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => void initMusicDownloads().catch(() => {}), []);
  // An account made for the user (at their first download) shows up here as it's made.
  useEffect(() => {
    setUsername(settings.soulseek_username);
    setPassword(settings.soulseek_password);
  }, [settings.soulseek_username, settings.soulseek_password]);
  const dirty = username.trim() !== settings.soulseek_username || password !== settings.soulseek_password;
  const saveAndConnect = async () => {
    setBusy(true);
    setError('');
    try {
      await updateSettings({ soulseek_username: username.trim(), soulseek_password: password });
      if (username.trim() && password) await connectSoulseek(true);
      else await disconnectSoulseek();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // Changing sharing or the port applies at the next login; reconnect now when online.
  const reconnectAfter = async (patch: Parameters<typeof updateSettings>[0]) => {
    await updateSettings(patch);
    if (useMusicDownloads.getState().status.state === 'online') await connectSoulseek(true).catch((e) => setError(errorMessage(e)));
  };
  const folders = settings.music_directories.map((d) => ({ value: d, label: d }));
  const tone = status.state === 'online' ? 'good' : status.state === 'error' ? 'bad' : 'muted';
  return (
    <Group
      title="Downloads · Soulseek"
      description="Browse → Music downloads from the Soulseek network. An account is made for you the first time you download; to use one of your own, enter it here."
      footer="The account is kept in your system's keychain. Soulseek creates an account the first time a new name signs in, and has no password reset. Only audio files (FLAC, MP3, M4A, Ogg, Opus) are downloaded, every track is checked against the album's tracklist, and albums are tagged with the store's album details."
    >
      <Row label="Account" description={<StatusText tone={tone}>{status.state === 'online' ? `Connected as ${status.username}` : status.state === 'connecting' ? 'Connecting…' : status.state === 'error' ? status.message : settings.soulseek_username ? 'Not connected (connects when you download)' : 'Made for you at your first download'}</StatusText>} stacked>
        <div className="flex flex-wrap gap-2">
          <input className={`${INPUT} w-48`} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" aria-label="Soulseek username" autoComplete="off" spellCheck={false} maxLength={30} />
          <input className={`${INPUT} w-48`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Soulseek password" autoComplete="off" />
          {dirty ? (
            <button className={BTN_PRIMARY} disabled={busy} onClick={() => void saveAndConnect()}>
              <LogIn className="h-4 w-4" /> Save and sign in
            </button>
          ) : status.state === 'online' ? (
            <button className={BTN} onClick={() => void disconnectSoulseek()}>
              <LogOut className="h-4 w-4" /> Disconnect
            </button>
          ) : (
            settings.soulseek_username && (
              <button className={BTN} disabled={busy || status.state === 'connecting'} onClick={() => void saveAndConnect()}>
                <LogIn className="h-4 w-4" /> Connect
              </button>
            )
          )}
        </div>
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </Row>
      <Row label="Quality" description="What the Download button takes by default (each album can pick its own).">
        <Segmented<MusicQuality>
          value={settings.soulseek_quality}
          onChange={(soulseek_quality) => void updateSettings({ soulseek_quality })}
          options={[['lossless', 'FLAC'], ['mp3', 'MP3'], ['any', 'Best']]}
        />
      </Row>
      {folders.length > 1 && (
        <Row label="Download into" description="Albums are filed here as Artist / Album (Year).">
          <Dropdown value={settings.music_download_dir && settings.music_directories.includes(settings.music_download_dir) ? settings.music_download_dir : folders[0].value} options={folders} onChange={(music_download_dir) => void updateSettings({ music_download_dir })} ariaLabel="Download folder" align="right" />
        </Row>
      )}
      <ToggleRow
        label="Share my music folders"
        description="Lets other Soulseek users download from your music folders, as the network expects. Off: you only download (some users may make you wait longer)."
        checked={settings.soulseek_share}
        onChange={(soulseek_share) => void reconnectAfter({ soulseek_share })}
      />
      <Row label="Listening port" description="Other users connect to you here. 0 turns listening off.">
        <NumberField value={settings.soulseek_port} min={0} max={65535} empty={2234} label="Soulseek listening port" className={`${INPUT} w-24 text-right tabular-nums`} onCommit={(soulseek_port) => void reconnectAfter({ soulseek_port })} />
      </Row>
    </Group>
  );
}
