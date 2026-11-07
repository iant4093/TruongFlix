import { useId, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { spring } from '../../lib/motion';

export interface Segment<T> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/**
 * Pill toggle between a few views (Movies / TV shows). Uses aria-pressed buttons in a labelled
 * group; the white highlight slides between options instead of jumping.
 */
export default function SegmentedControl<T extends string | number | boolean>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  className = '',
}: {
  value: T;
  options: Segment<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const highlight = useId();
  return (
    <div role="group" aria-label={ariaLabel} className={`flex shrink-0 rounded border border-white/20 bg-black/30 p-1 ${className}`}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`relative flex items-center gap-1.5 rounded text-sm font-medium transition-colors duration-150 ${size === 'sm' ? 'px-3 py-1.5' : 'px-5 py-2'} ${
              selected ? 'text-black' : 'text-white/65 hover:text-white'
            }`}
          >
            {selected && (
              <motion.span
                aria-hidden="true"
                layoutId={highlight}
                transition={spring.highlight}
                className="absolute inset-0 rounded bg-white"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
