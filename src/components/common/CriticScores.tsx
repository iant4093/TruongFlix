/** Rotten Tomatoes (fresh tomato ≥ 60%, splat below) and Metacritic badges. */
export default function CriticScores({ rt, metacritic, size = 'sm' }: { rt: number | null; metacritic: number | null; size?: 'sm' | 'md' }) {
  if (rt == null && metacritic == null) return null;
  const icon = size === 'md' ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5';
  const text = size === 'md' ? 'text-[15px]' : 'text-xs';
  const metaColor = metacritic == null ? '' : metacritic >= 61 ? 'bg-[#00ce7a] text-black' : metacritic >= 40 ? 'bg-[#ffbd3f] text-black' : 'bg-[#ff6874] text-black';
  return (
    <span className={`inline-flex items-center gap-2.5 font-semibold ${text}`}>
      {rt != null && (
        <span className="inline-flex items-center gap-1" title={`Rotten Tomatoes: ${rt}% of critics`}>
          {rt >= 60 ? (
            <svg viewBox="0 0 24 24" className={icon} aria-hidden>
              <path d="M12 7c5 0 9 3.2 9 7.6S17.2 22 12 22 3 19.4 3 14.6 7 7 12 7z" fill="#FA320A" />
              <path d="M12.4 7.6c.3-2 1.6-3.4 3.6-3.9-.6 1.4-.4 2.6.7 3.6-1.2-.5-2.6-.3-4.3.3z" fill="#00912D" />
              <path d="M11.6 7.4C10.8 5.9 9.4 5.2 7.6 5.4c1.2.8 1.7 1.7 1.6 2.9.6-.6 1.5-.9 2.4-.9z" fill="#00912D" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className={icon} aria-hidden>
              <path d="M12 3l1.6 4.2 4.4-2.1-1.4 4.5 4.7.8-3.9 2.7 3.2 3.5-4.7-.2.5 4.7-4-2.6L10 23l-.7-4.6-4.2 2.2 1.6-4.4-4.6-.9 3.9-2.6-3.1-3.6 4.7.4-.4-4.7 4 2.6z" fill="#0AC855" />
            </svg>
          )}
          {rt}%
        </span>
      )}
      {metacritic != null && (
        <span className="inline-flex items-center gap-1" title={`Metacritic: ${metacritic}/100`}>
          <span className={`inline-flex min-w-[1.6em] items-center justify-center rounded-[3px] px-1 font-bold leading-tight ${metaColor}`}>{metacritic}</span>
          {size === 'md' && <span className="font-normal text-nf-secondary">Metacritic</span>}
        </span>
      )}
    </span>
  );
}
