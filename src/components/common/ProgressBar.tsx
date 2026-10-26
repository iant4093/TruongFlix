interface Props {
  value: number; // 0..1
  className?: string;
  height?: number;
}

/** Netflix red progress bar on a grey track. */
export default function ProgressBar({ value, className = '', height = 3 }: Props) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`w-full overflow-hidden bg-[#4d4d4d] ${className}`} style={{ height }}>
      <div className="h-full bg-nf-red" style={{ width: `${pct}%` }} />
    </div>
  );
}
