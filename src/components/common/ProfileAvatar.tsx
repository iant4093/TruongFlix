import type { Maturity } from '../../types/media';

/** Square avatar with a simple face (our own design) in the profile's colour; kids get a star. */
export default function ProfileAvatar({
  color,
  maturity,
  size = 32,
  className = '',
}: {
  color: string;
  maturity?: Maturity;
  size?: number;
  className?: string;
}) {
  const kids = maturity === 'kids';
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size, borderRadius: Math.max(4, size * 0.08), background: `linear-gradient(145deg, ${color}, ${color}cc 60%, ${color}88)` }}
    >
      <svg viewBox="0 0 40 40" width="100%" height="100%">
        {kids ? (
          <path d="M20 7l3.6 7.5 8.2 1.1-6 5.7 1.5 8.1L20 25.5l-7.3 3.9 1.5-8.1-6-5.7 8.2-1.1z" fill="rgba(255,255,255,0.92)" />
        ) : (
          <>
            <rect x="11.5" y="13" width="4" height="6.5" rx="2" fill="#fff" />
            <rect x="24.5" y="13" width="4" height="6.5" rx="2" fill="#fff" />
            <path d="M10.5 25c2.6 3.4 5.8 5 9.5 5s6.9-1.6 9.5-5" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}
