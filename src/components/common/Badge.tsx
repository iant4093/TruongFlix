import type { ReactNode } from 'react';

type Tone = 'neutral' | 'download' | 'red' | 'green' | 'warn';

const TONES: Record<Tone, string> = {
  neutral: 'bg-white/10 text-white/80',
  download: 'bg-nf-download/20 text-nf-download-text',
  red: 'bg-nf-red/15 text-nf-red',
  green: 'bg-nf-green/15 text-nf-green',
  warn: 'bg-nf-warn/15 text-nf-warn',
};

/** Small count or status chip. `pill` for counts beside a nav label. */
export default function Badge({ children, tone = 'neutral', pill = false, className = '', title, label }: {
  children: ReactNode;
  tone?: Tone;
  pill?: boolean;
  className?: string;
  title?: string;
  label?: string;
}) {
  return (
    <span
      title={title}
      aria-label={label}
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${pill ? 'rounded-full' : 'rounded'} ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
