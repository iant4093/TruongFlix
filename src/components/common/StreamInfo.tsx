import type { CastMember, MediaInfo } from '../../types/media';
import { describeStreams, formatSize } from '../../services/mediainfo';
import { useLibraryStore } from '../../store/useLibraryStore';

/** "Video / Audio / Subtitles / File" lines read from the actual file. */
export function StreamInfo({ info, size }: { info: MediaInfo | null; size?: number | null }) {
  if (!info) return null;
  const d = describeStreams(info);
  const bytes = info.size ?? size;
  return (
    <>
      <p>
        <span className="text-nf-muted">Video: </span>
        {d.video}
      </p>
      {d.audio.length > 0 && (
        <p>
          <span className="text-nf-muted">Audio: </span>
          {d.audio.slice(0, 2).join(' | ')}
          {d.audio.length > 2 && <span className="text-nf-muted"> (+{d.audio.length - 2} more)</span>}
        </p>
      )}
      {d.subtitles > 0 && (
        <p>
          <span className="text-nf-muted">Subtitles: </span>
          {d.subtitles} embedded
        </p>
      )}
      {(bytes || info.chapters.length > 1) && (
        <p>
          <span className="text-nf-muted">File: </span>
          {[formatSize(bytes), info.chapters.length > 1 ? `${info.chapters.length} chapters` : ''].filter(Boolean).join(' · ')}
        </p>
      )}
      {info.dv_profile === 5 && navigator.userAgent.includes('Mac') && (
        <p className="text-amber-400/90">Dolby Vision profile 5 — colours may look off in the built-in player on macOS.</p>
      )}
    </>
  );
}

/** Comma-separated names that open the actor page. */
export function CastLinks({ people, limit }: { people: CastMember[]; limit?: number }) {
  const openActor = useLibraryStore((s) => s.openActor);
  const shown = limit ? people.slice(0, limit) : people;
  return (
    <>
      {shown.map((c, i) => (
        <span key={`${c.name}-${i}`}>
          {i > 0 && ', '}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openActor({ name: c.name, id: c.id, profile: c.profile_path });
            }}
            className="text-left hover:underline"
          >
            {c.name}
          </button>
        </span>
      ))}
      {limit && people.length > limit && <span className="italic text-white/80">, more</span>}
    </>
  );
}
