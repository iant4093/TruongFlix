import type { Ref } from 'react';
import { Search } from 'lucide-react';

/** Text input with a leading search icon. */
export default function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = '',
  inputClassName = 'w-full',
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className={`flex items-center gap-2 rounded border border-white/25 bg-black/40 px-3 py-2.5 transition-colors focus-within:border-white/60 ${className}`}>
      <Search className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`min-w-0 bg-transparent text-sm text-white outline-none placeholder:text-white/40 ${inputClassName}`}
      />
    </label>
  );
}
