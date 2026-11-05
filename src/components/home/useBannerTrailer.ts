import { useEffect, useRef, useState } from 'react';
import { resolveTrailer, type TrailerSource, type TrailerTitle } from '../../services/trailers';
import { useLibraryStore } from '../../store/useLibraryStore';
import { trailerInsets } from '../../services/trailerFrame';

type Phase = 'waiting' | 'loading' | 'playing' | 'ended' | 'failed';
const DELAY = 4000;
const AUDIO_START_TIMEOUT = 5000;

export function useBannerVisibility(blocked = false) {
  const overlay = useLibraryStore(
    (s) => !!s.detailKey || !!s.playerSession || s.settingsOpen || s.onboardingOpen || !!s.fixMatchKey ||
      !!s.profileGate || !!s.actor || !!s.overlay || !!s.addTorrentModal?.open,
  );
  const isVisible = () => !document.hidden && window.scrollY < window.innerHeight * 0.5;
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return visible && !overlay && !blocked;
}

/** Background trailers never share the main player's sessions, history, audio devices or subtitles. */
export function useBannerTrailer(item: TrailerTitle & { key: string }, enabled: boolean, playing: boolean) {
  const identity = `${item.key}/${item.kind}/${item.tmdbId}/${item.trailerKey}`;
  const [resolved, setResolved] = useState<{ identity: string; source: TrailerSource } | null>(null);
  const source = enabled && resolved?.identity === identity ? resolved.source : null;
  const [phase, setPhase] = useState<Phase>('waiting');
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(true);
  const [delayPassed, setDelayPassed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioStart = useRef<{ start: () => void; cancel: (resume?: boolean) => void } | null>(null);
  const allowedRef = useRef(false);
  allowedRef.current = enabled && playing && delayPassed;
  const visible = !!source && active && allowedRef.current;

  useEffect(() => {
    setResolved(null); setPhase('waiting'); setActive(false); setMuted(true); setDelayPassed(false); setCrop({ x: 0, y: 0 });
  }, [identity, enabled, retry]);

  useEffect(() => {
    if (!enabled || !playing || delayPassed) return;
    const timer = window.setTimeout(() => setDelayPassed(true), DELAY);
    return () => window.clearTimeout(timer);
  }, [identity, enabled, playing, delayPassed, retry]);

  useEffect(() => {
    if (!enabled || !playing || source || phase === 'failed' || phase === 'ended' || (!item.trailerKey && !item.tmdbId)) return;
    let alive = true;
    setPhase('loading');
    void resolveTrailer(item, retry > 0).then((source) => {
      if (alive) setResolved({ identity, source });
    }).catch(() => { if (alive) setPhase('failed'); });
    return () => { alive = false; };
  }, [identity, enabled, playing, source, retry]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !source) return;
    let alive = true;
    let frame = 0;
    let videoRunning = false;
    let audioStartTimer: number | null = null;
    let audioPending = false;
    let nextAudioAttempt = 0;
    let framed = false;
    const frameTrailer = () => {
      if (framed || !video.videoWidth) return;
      framed = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 90;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(video, 0, 0, 160, 90);
        setCrop(trailerInsets(context.getImageData(0, 0, 160, 90).data, 160, 90));
      } catch { /* Keep the natural frame when pixel access is unavailable. */ }
    };
    const sync = () => {
      if (!audio || !videoRunning || audio.muted || audio.ended || !allowedRef.current || video.paused || video.readyState < 3 || video.seeking) return;
      if (audio.paused) {
        if (!audioPending && Date.now() >= nextAudioAttempt) {
          audioPending = true;
          void audio.play().catch(() => { nextAudioAttempt = Date.now() + 2000; }).finally(() => { audioPending = false; });
        }
        return;
      }
      if (audio.seeking || audio.readyState < 3) return;
      // Leave the audible track alone during playback. Seeking it discards decoded
      // audio and can start another buffer, which makes drift and dropouts repeat.
      const drift = audio.currentTime - video.currentTime;
      const rate = Math.abs(drift) < 0.08 ? 1 : 1 + Math.max(-0.12, Math.min(0.12, drift * 0.3));
      if (Math.abs(video.playbackRate - rate) >= 0.01 || (rate === 1 && video.playbackRate !== 1)) {
        video.playbackRate = rate;
      }
    };
    const reveal = () => {
      if (!alive || !allowedRef.current || video.paused || video.ended || video.readyState < 2) return;
      videoRunning = true;
      // Set the framing before showing the first frame and keep it for the whole trailer.
      frameTrailer();
      setActive(true); setPhase('playing'); sync();
    };
    const started = () => {
      if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(reveal);
      else reveal();
    };
    const hide = () => {
      videoRunning = false;
      if (frame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame);
      frame = 0;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      setActive(false); audio?.pause();
    };
    const resumeVideo = () => {
      if (!alive || !allowedRef.current || video.ended) return;
      void video.play().catch(() => {
        if (alive && allowedRef.current && audioStartTimer == null) { hide(); setPhase('failed'); }
      });
    };
    const cancelAudioStart = (resume = false) => {
      if (audioStartTimer == null) return;
      window.clearTimeout(audioStartTimer);
      audioStartTimer = null;
      if (resume) resumeVideo();
    };
    const startAudio = () => {
      if (!audio || !allowedRef.current || video.ended) return;
      audio.currentTime = video.currentTime;
      if (video.paused) return;
      // Keep the decoded picture visible at the point where we cued the audio.
      // The play promise resolves only when the audible track starts advancing.
      const finish = (failed: boolean) => {
        if (audioStartTimer !== timer) return;
        cancelAudioStart();
        if (failed) {
          audio.muted = true;
          audio.pause();
          setMuted(true);
        }
        resumeVideo();
      };
      const timer = window.setTimeout(() => finish(true), AUDIO_START_TIMEOUT);
      audioStartTimer = timer;
      videoRunning = false;
      video.pause();
      void audio.play().then(() => finish(false), () => finish(true));
    };
    audioStart.current = { start: startAudio, cancel: cancelAudioStart };

    const interrupted = () => {
      if (audioStartTimer == null || !allowedRef.current) hide();
    };
    const paused = () => { if (video.paused) interrupted(); };
    const ended = () => { cancelAudioStart(); hide(); setPhase('ended'); };
    const failed = () => { cancelAudioStart(); hide(); video.pause(); setPhase('failed'); };
    video.addEventListener('playing', started);
    video.addEventListener('waiting', interrupted);
    video.addEventListener('seeking', interrupted);
    video.addEventListener('pause', paused);
    video.addEventListener('ended', ended);
    video.addEventListener('error', failed);
    const timer = window.setInterval(sync, 250);
    return () => {
      alive = false;
      cancelAudioStart();
      audioStart.current = null;
      if (frame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame);
      window.clearInterval(timer);
      video.pause(); audio?.pause();
      video.removeEventListener('playing', started);
      video.removeEventListener('waiting', interrupted);
      video.removeEventListener('seeking', interrupted);
      video.removeEventListener('pause', paused);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', failed);
    };
  }, [source]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !!source?.audioUrl || muted;
    if (audioRef.current) audioRef.current.muted = muted;
  }, [source, muted]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !source) return;
    if (!enabled || !playing || !delayPassed || phase === 'failed') {
      audioStart.current?.cancel();
      video.pause(); audio?.pause(); setActive(false); return;
    }
    if (video.ended || phase === 'ended') return;
    let cancelled = false;
    void video.play().catch(() => { if (!cancelled) { setActive(false); setPhase('failed'); } });
    return () => { cancelled = true; };
  }, [enabled, playing, delayPassed, source]);

  useEffect(() => {
    if (!source || !playing || !delayPassed || active || phase === 'ended' || phase === 'failed') return;
    const timer = window.setTimeout(() => {
      videoRef.current?.pause(); audioRef.current?.pause(); setPhase('failed');
    }, 25_000);
    return () => window.clearTimeout(timer);
  }, [source, playing, delayPassed, active, phase]);

  const toggleMute = () => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (phase === 'failed') { setRetry((n) => n + 1); return; }
    if (!video) return;
    if (phase === 'ended') {
      video.currentTime = 0;
      if (audio) audio.currentTime = 0;
      setPhase('loading');
      void video.play().catch(() => setPhase('failed'));
      return;
    }
    const next = !muted;
    setMuted(next);
    if (audio) {
      audio.muted = next;
      if (!next) {
        // Start within the button's user gesture for WebKit's audio policy.
        audioStart.current?.start();
      } else {
        audio.pause();
        if (video.playbackRate !== 1) video.playbackRate = 1;
        audioStart.current?.cancel(true);
      }
    } else video.muted = next;
  };
  const frameStyle = { width: `${100 / (1 - crop.x * 2)}%`, height: `${100 / (1 - crop.y * 2)}%`, transform: 'translate(-50%, -50%)' };
  return { source, phase, active: visible, muted, videoRef, audioRef, toggleMute, frameStyle };
}
