/** Netflix-style age-rating box (e.g. PG-13, TV-MA). */
export default function MaturityRating({ rating, size = 'sm', className = '' }: { rating: string | null; size?: 'sm' | 'md'; className?: string }) {
  if (!rating) return null;
  const sizing = size === 'md' ? 'px-1.5 py-[1px] text-xs' : 'px-1 text-[10px]';
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap border border-white/40 font-medium leading-tight text-white/90 ${sizing} ${className}`}>
      {rating}
    </span>
  );
}
