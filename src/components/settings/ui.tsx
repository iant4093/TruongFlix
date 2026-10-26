import type { ReactNode } from 'react';

/** Shared building blocks so every settings page looks the same. */

export const BTN = 'nf-btn-ghost h-9 shrink-0 px-3 py-0 text-sm';
export const BTN_PRIMARY = 'nf-btn-red h-9 shrink-0 px-4 py-0 text-sm';
export const BTN_DANGER = 'nf-btn-ghost h-9 shrink-0 px-3 py-0 text-sm hover:!border-nf-red hover:!bg-nf-red/20 hover:!text-white';
export const INPUT = 'h-9 min-w-0 rounded border border-white/15 bg-black/40 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-white/40';

export function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-bold">{title}</h2>
        {description && <p className="mt-1 text-sm text-nf-secondary">{description}</p>}
      </header>
      {children}
    </div>
  );
}

/** A titled card; its rows are separated by hairlines. */
export function Group({ title, description, children, footer }: { title?: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section>
      {(title || description) && (
        <div className="mb-2 px-1">
          {title && <h3 className="text-xs font-semibold uppercase tracking-widest text-nf-muted">{title}</h3>}
          {description && <p className="mt-1 text-xs leading-relaxed text-nf-muted">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-white/[0.08] overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">{children}</div>
      {footer && <div className="mt-2 px-1 text-xs leading-relaxed text-nf-muted">{footer}</div>}
    </section>
  );
}

/** Label and description on the left, the control on the right (or below with `stacked`). */
export function Row({
  label,
  description,
  children,
  stacked,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={`px-4 py-3.5 ${stacked ? 'space-y-3' : 'flex items-center gap-4'}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-nf-muted">{description}</div>}
      </div>
      {children != null && <div className={stacked ? '' : 'flex shrink-0 items-center gap-2'}>{children}</div>}
    </div>
  );
}

/** Free-form content inside a group (lists, previews…). */
export function Block({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-4 py-3.5 ${className}`}>{children}</div>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-nf-red' : 'bg-[#4d4d4d]'}`}
    >
      <span className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function ToggleRow({ label, description, checked, onChange }: { label: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} description={description}>
      <Switch checked={checked} onChange={onChange} label={label} />
    </Row>
  );
}

/** Small segmented choice (e.g. subtitle size S / M / L / XL). */
export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded border px-2.5 py-1 text-xs transition-colors ${
            value === v ? 'border-white bg-white font-semibold text-black' : 'border-white/25 text-nf-secondary hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function StatusText({ tone = 'muted', children }: { tone?: 'muted' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const color = tone === 'good' ? 'text-nf-green' : tone === 'warn' ? 'text-[#e87c03]' : tone === 'bad' ? 'text-nf-red' : 'text-nf-muted';
  return <span className={`text-xs ${color}`}>{children}</span>;
}
