type Tone = 'red' | 'download' | 'warn' | 'green' | 'white';

interface Props {
  value: number; // 0..1
  className?: string;
  /** Pixel height; overrides `size`. */
  height?: number;
  size?: 'thin' | 'regular';
  tone?: Tone;
  /** `overlay` darkens instead of greying, for bars laid over artwork. */
  track?: 'default' | 'overlay';
  /** Smallest visible fill (0..1) so a just-started bar still shows. */
  min?: number;
  rounded?: boolean;
  animated?: boolean;
  label?: string;
}

const TONES: Record<Tone, string> = {
  red: 'bg-nf-red',
  download: 'bg-nf-download',
  warn: 'bg-nf-warn',
  green: 'bg-nf-green',
  white: 'bg-white',
};

/** Thin progress bar on the grey track (red for watching, blue for downloads). */
export default function ProgressBar({ value, className = '', height, size = 'thin', tone = 'red', track = 'default', min = 0, rounded = false, animated = false, label }: Props) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const pct = Math.max(min, clamped) * 100;
  return (
    <div
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? Math.round(clamped * 100) : undefined}
      className={`w-full overflow-hidden ${track === 'overlay' ? 'bg-black/80' : 'bg-nf-track'} ${rounded ? 'rounded-full' : ''} ${height == null ? (size === 'thin' ? 'h-[3px]' : 'h-1.5') : ''} ${className}`}
      style={height == null ? undefined : { height }}
    >
      <div className={`h-full ${TONES[tone]} ${rounded ? 'rounded-full' : ''} ${animated ? 'transition-all duration-300' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
