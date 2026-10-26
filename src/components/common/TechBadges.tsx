import type { TechInfo } from '../../types/media';

interface Props {
  tech: TechInfo;
  showCodec?: boolean;
  showAudio?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function techBadgeList(tech: TechInfo, showCodec = true, showAudio = true): string[] {
  const out: string[] = [];
  if (tech.resolution) out.push(tech.resolution === '4K' ? '4K' : tech.resolution);
  if (tech.hdr_format) out.push(tech.hdr_format);
  if (showCodec && tech.video_codec) out.push(tech.video_codec);
  if (showAudio && tech.audio_codec) out.push(...tech.audio_codec.split(',').map((s) => s.trim()).filter(Boolean));
  return out;
}

/** Netflix-style bordered tech pills: 4K · Dolby Vision · HEVC · Atmos · 5.1 */
export default function TechBadges({ tech, showCodec = true, showAudio = true, size = 'sm', className = '' }: Props) {
  const badges = techBadgeList(tech, showCodec, showAudio);
  if (!badges.length) return null;
  const sizing = size === 'sm' ? 'text-[10px] px-[5px] py-[1px]' : 'text-xs px-1.5 py-[2px]';
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {badges.map((b) => (
        <span
          key={b}
          className={`whitespace-nowrap rounded-[3px] border border-white/40 font-medium uppercase leading-tight tracking-wide text-white/85 ${sizing}`}
        >
          {b}
        </span>
      ))}
    </span>
  );
}
