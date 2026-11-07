/** One display style for sizes, clocks and durations across the app. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function scaled(bytes: number, decimalsFrom: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Rounding can carry over (1023.6 MB → "1024 MB"); show the next unit instead.
  if (unit < decimalsFrom && unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= decimalsFrom ? 1 : 0)} ${UNITS[unit]}`;
}

/** "0 B", "512 KB", "700 MB", "1.4 GB": one decimal from GB up, whole numbers below. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  return scaled(bytes, 3);
}

/** Transfer rate: "850 KB/s", "4.2 MB/s" (one decimal from MB/s up). */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 KB/s';
  return `${scaled(Math.max(1024, bytesPerSecond), 2)}/s`;
}

/** Playback position: "1:02:03" or "4:05". Splits whole seconds so it never shows "1:60". */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Watch time rounded to minutes: "42m", "1h 42m". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A 0–100 percentage: "42%", or "42.5%" with `digits = 1`. Clamped to the range. */
export function formatPercent(percent: number, digits = 0): string {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return `${value.toFixed(digits)}%`;
}
