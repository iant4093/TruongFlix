import { Loader2 } from 'lucide-react';

const TONES = { red: 'text-nf-red', muted: 'text-nf-secondary', inherit: '' } as const;

/** Spinning loader icon. Decorative unless given a `label`. */
export default function Spinner({ className = 'h-5 w-5', tone = 'red', label }: { className?: string; tone?: keyof typeof TONES; label?: string }) {
  return (
    <Loader2
      className={`shrink-0 animate-spin ${TONES[tone]} ${className}`}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
