import { useEffect, useRef } from 'react';
import { httpMusicApi } from '../music/api';
import FullPlayer from '../music/components/FullPlayer';
import MiniBar from '../music/components/MiniBar';
import MusicLibrary from '../music/components/MusicLibrary';
import MusicOverlays from '../music/components/Overlays';
import { initMusicPlayer, stopMusic, useMusicPlayer } from '../music/player';
import { api } from './api';

type ArtOverride = (art: string | null | undefined) => string | null;

/** Connects the music player to the PC for this profile; returns whether a song is loaded. */
export function useRemoteMusic(who: { id: number; key?: string }) {
  const profile = useRef<number | null>(null);
  useEffect(() => {
    const client = httpMusicApi(api, who);
    const preview = (window as { __TF_MUSIC_ART__?: ArtOverride }).__TF_MUSIC_ART__;
    if (preview) client.artUrl = preview;
    if (profile.current != null && profile.current !== who.id) {
      // Another profile: its own favourites, plays and playlists.
      stopMusic();
      useMusicPlayer.setState({ library: null, byId: new Map() });
    }
    profile.current = who.id;
    initMusicPlayer(client, { mediaSession: true });
  }, [who.id, who.key]);
  return useMusicPlayer((s) => !!s.track);
}

/** Mini bar, full-screen player and music dialogs (kept on every tab so music keeps playing). */
export function RemoteMusicPlayer({ lifted }: { lifted: boolean }) {
  return (
    <>
      <MiniBar compact className={lifted ? '!bottom-[4.75rem]' : ''} />
      <FullPlayer />
      <MusicOverlays />
    </>
  );
}

export function RemoteMusicSection() {
  return <MusicLibrary variant="phone" />;
}
