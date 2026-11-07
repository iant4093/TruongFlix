import type { CSSProperties, ReactNode } from 'react';

/**
 * The app's loading placeholders. Each mirrors the real layout's footprint (same padding, aspect
 * ratios and line heights) so content replaces it without anything moving.
 */
export function Bone({ className = '', style, tone = 'base' }: { className?: string; style?: CSSProperties; tone?: 'base' | 'soft' | 'strong' }) {
  const bg = tone === 'soft' ? 'bg-white/[0.07]' : tone === 'strong' ? 'bg-white/15' : 'bg-[#232323]';
  return <div aria-hidden="true" className={`animate-pulse rounded-sm motion-reduce:animate-none ${bg} ${className}`} style={style} />;
}

/** Wraps placeholders with one polite "loading" announcement. */
export function SkeletonStatus({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/** The billboard's exact footprint: title, meta line, overview and two buttons. */
export function BillboardSkeleton() {
  return (
    <section aria-hidden="true" className="nf-billboard bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.06),transparent_60%)]">
      <div className="nf-billboard-copy w-[40%]">
        <Bone tone="soft" className="h-[clamp(2.2rem,4.6vw,4.5rem)] w-4/5 rounded" />
        <Bone tone="soft" className="h-4 w-1/2 rounded" />
        <div className="space-y-2">
          <Bone tone="soft" className="h-4 w-full rounded" />
          <Bone tone="soft" className="h-4 w-3/4 rounded" />
        </div>
        <div className="mt-1 flex gap-3">
          <Bone tone="strong" className="h-12 w-40 rounded" />
          <Bone tone="soft" className="h-12 w-44 rounded" />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[45%]" style={{ background: 'linear-gradient(180deg, rgba(20,20,20,0) 0%, #141414 100%)' }} />
    </section>
  );
}

/** A carousel row (matches `Slider`): title bar, then one page of landscape or portrait cards. */
export function RowSkeleton({ perPage, shape = 'landscape', padded = false }: { perPage: number; shape?: 'landscape' | 'portrait'; padded?: boolean }) {
  return (
    <section aria-hidden="true" className="my-[3vw] first:mt-0">
      <div className="mb-2 flex items-end px-[4%]">
        {/* Same font box as the row title, so the real heading lands on the same baseline. */}
        <div className="nf-row-title">
          <span className="inline-block h-[0.9em] w-48 animate-pulse rounded-sm bg-[#2a2a2a] align-middle motion-reduce:animate-none" />
        </div>
      </div>
      <div className={`flex overflow-hidden px-[4%] ${padded ? 'py-2' : ''}`}>
        {Array.from({ length: perPage }, (_, i) => (
          <div key={i} className="shrink-0 px-[0.2vw]" style={{ width: `${100 / perPage}%` }}>
            <Bone className={`w-full ${shape === 'portrait' ? 'aspect-[2/3]' : 'aspect-video'}`} style={{ animationDelay: `${i * 80}ms` }} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Poster grid cells with the caption lines (title + one meta line) the real cards use. */
export function PosterGridSkeleton({ count, className }: { count: number; className: string }) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="min-w-0">
          <Bone className="aspect-[2/3] w-full rounded-md" style={{ animationDelay: `${(i % 7) * 60}ms` }} />
          <div className="mt-3 flex h-5 items-center"><Bone className="h-3.5 w-3/4" /></div>
          <div className="mt-1 flex h-4 items-center"><Bone tone="soft" className="h-3 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

/** Live TV event cards: scoreboard, league line, two-line title, broadcasters and the feed footer. */
export function EventCardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-lg border border-white/10 bg-nf-hover">
      <Bone tone="soft" className="h-44 w-full rounded-none" />
      <div className="p-4">
        <div className="mb-2 flex h-[15px] items-center justify-between"><Bone className="h-2.5 w-16" /><Bone className="h-2.5 w-20" /></div>
        <div className="flex min-h-10 flex-col justify-center gap-2"><Bone className="h-3.5 w-4/5" /><Bone className="h-3.5 w-1/2" /></div>
        <div className="mt-2 flex h-4 items-center"><Bone tone="soft" className="h-3 w-2/5" /></div>
        <div className="mt-4 flex h-[29px] items-end border-t border-white/10"><Bone tone="soft" className="h-3 w-1/3" /></div>
      </div>
    </div>
  );
}

/** Live TV channel tiles. */
export function ChannelTileSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-w-0 items-center gap-3 rounded-md border border-white/10 bg-nf-hover p-4">
      <Bone tone="soft" className="h-12 w-16 rounded" />
      <div className="min-w-0 flex-1 space-y-2">
        <Bone className="h-3.5 w-3/5" />
        <Bone tone="soft" className="h-3 w-4/5" />
      </div>
    </div>
  );
}
