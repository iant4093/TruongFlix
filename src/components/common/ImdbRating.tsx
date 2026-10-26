import { useLibraryStore } from '../../store/useLibraryStore';
import { formatVotes, openImdb } from '../../services/imdb';

interface Props {
  rating: number | null | undefined;
  votes?: number | null;
  /** When set, clicking opens the title on imdb.com. */
  imdbId?: string | null;
  showVotes?: boolean;
  /** Extra label after the score, e.g. "season avg". */
  suffix?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** IMDb's yellow wordmark + score. Renders nothing when ratings are off or missing. */
export default function ImdbRating({ rating, votes, imdbId, showVotes, suffix, size = 'sm', className = '' }: Props) {
  const enabled = useLibraryStore((s) => s.settings.imdb_enabled);
  if (!enabled || rating == null) return null;

  const badge = size === 'md' ? 'text-[11px] px-[5px] py-[1px]' : 'text-[9px] px-1 py-0';
  const content = (
    <>
      <span className={`rounded-[3px] bg-[#F5C518] font-black leading-[1.35] tracking-tight text-black ${badge}`}>IMDb</span>
      <span className="font-semibold text-white">{rating.toFixed(1)}</span>
      {showVotes && votes ? <span className="font-normal text-nf-muted">({formatVotes(votes)})</span> : null}
      {suffix && <span className="font-normal text-nf-muted">{suffix}</span>}
    </>
  );
  const cls = `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap ${className}`;

  if (imdbId) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void openImdb(imdbId);
        }}
        title="View on IMDb"
        className={`${cls} rounded transition-opacity hover:opacity-80`}
      >
        {content}
      </button>
    );
  }
  return <span className={cls}>{content}</span>;
}
