import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import Spinner from './Spinner';

/** Spinner with optional text: centred block by default, or a single muted line with `inline`. */
export function LoadingState({ label, inline = false, className = '' }: { label?: string; inline?: boolean; className?: string }) {
  if (inline) {
    return (
      <div role="status" className={`flex items-center gap-3 text-nf-secondary ${className}`}>
        <Spinner tone="inherit" /> {label}
      </div>
    );
  }
  return (
    <div role="status" className={`flex flex-col items-center justify-center gap-3 py-10 text-sm text-nf-secondary ${className}`}>
      <Spinner className="h-7 w-7" label={label ? undefined : 'Loading'} />
      {label}
    </div>
  );
}

/** A failed load with an optional retry, shown as a strip above the content. */
export function ErrorBanner({
  children,
  onRetry,
  retryLabel = 'Retry',
  className = '',
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={`flex items-center justify-between gap-4 rounded-md border border-nf-red/30 bg-nf-red/10 px-4 py-3 text-sm text-red-100 ${className}`}>
      <span className="min-w-0">{children}</span>
      {onRetry && (
        <button type="button" className="nf-btn-ghost shrink-0 text-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Page-level message where a whole view would be (no results, not available, restricted). */
export function HeroEmptyState({ title, icon, children, action }: { title: string; icon?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="px-[4%] pb-20 pt-32">
      {icon && <div className="mb-5">{icon}</div>}
      <h1 className="text-4xl font-bold">{title}</h1>
      {children && <div className="mt-5 max-w-2xl text-nf-secondary">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </section>
  );
}

/** Shown in place of adult-only views (Browse, Live TV, Games) on kids/teen profiles. */
export function RestrictedProfileNotice({ title, reason, action, icon }: { title: string; reason?: string; action: string; icon?: ReactNode }) {
  return (
    <HeroEmptyState title={title} icon={icon ?? <Lock className="h-10 w-10 text-nf-muted" aria-hidden />}>
      <p>
        {reason ? `${reason} ` : ''}Switch to an unrestricted profile to {action}.
      </p>
    </HeroEmptyState>
  );
}
