import { useState, type Ref } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { useBannerTrailer } from './useBannerTrailer';

type Trailer = ReturnType<typeof useBannerTrailer>;

export function BillboardMedia({ title, backdrop, trailer }: { title: string; backdrop: string | null; trailer: Trailer }) {
  const [loadedBackdrop, setLoadedBackdrop] = useState<string | null>(null);
  const loaded = backdrop === loadedBackdrop;
  return (
    <>
      {backdrop && (
        <motion.img
          key={backdrop}
          src={backdrop}
          alt=""
          draggable={false}
          onLoad={() => setLoadedBackdrop(backdrop)}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: loaded ? 1 : 0, scale: loaded ? 1 : 1.04 }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      )}
      <TrailerLayer title={title} trailer={trailer} />
      <div className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(77deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 85%)' }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[45%]"
        style={{ background: 'linear-gradient(180deg, rgba(20,20,20,0) 0%, rgba(20,20,20,0.6) 60%, #141414 100%)' }} />
    </>
  );
}

function TrailerLayer({ title, trailer }: { title: string; trailer: Trailer }) {
  const { source, active, muted, videoRef, audioRef, frameStyle } = trailer;
  if (!source) return null;
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: active ? 1 : 0 }}
      transition={{ duration: active ? 0.6 : 0, ease: 'easeOut' }}
    >
      <video
        key={source.videoUrl}
        ref={videoRef}
        crossOrigin="anonymous"
        src={source.videoUrl}
        aria-label={`${title} trailer`}
        muted={source.audioUrl ? true : muted}
        playsInline
        preload="auto"
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload nofullscreen noremoteplayback"
        tabIndex={-1}
        className="trailer-video absolute left-1/2 top-1/2 border-0 object-cover"
        style={frameStyle}
      />
      {source.audioUrl && <audio ref={audioRef} src={source.audioUrl} preload="auto" className="hidden" />}
    </motion.div>
  );
}

export function BillboardControls({ trailer, certification, controlsRef }: {
  trailer: Trailer;
  certification: string | null;
  controlsRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={controlsRef} className="nf-billboard-controls">
      <TrailerControl trailer={trailer} />
      {certification && (
        <div className="flex h-9 items-center border-l-[3px] border-[#dcdcdc] bg-[rgba(51,51,51,0.6)] pl-3 pr-[4vw] text-lg">
          {certification}
        </div>
      )}
    </div>
  );
}

function TrailerControl({ trailer }: { trailer: Trailer }) {
  const { phase, source, muted, toggleMute } = trailer;
  if (phase !== 'playing' && phase !== 'ended' && phase !== 'failed') return null;
  const label = phase === 'failed' ? 'Retry trailer' : phase === 'ended' ? 'Replay trailer' : muted ? 'Unmute trailer' : 'Mute trailer';
  const Icon = phase === 'ended' || phase === 'failed' ? RotateCcw : muted ? VolumeX : Volume2;
  return (
    <button
      onClick={toggleMute}
      aria-label={label}
      title={source ? `${label} · ${source.height}p` : label}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-white/60 bg-black/20 transition hover:bg-white/10"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
