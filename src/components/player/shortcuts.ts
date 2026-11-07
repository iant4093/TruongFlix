/** Let focused controls handle their own keyboard input before player shortcuts. */
export function isPlayerShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key === 'Escape') return true;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="listbox"], [role="slider"]')) return false;
  return !((event.key === ' ' || event.key === 'Enter') && target.closest('button, a[href], [role="button"]'));
}

export const playerControlTitles = {
  play: 'Play (Space)',
  pause: 'Pause (Space)',
  rewind: 'Back 10 seconds (←)',
  forward: 'Forward 10 seconds (→)',
  chapters: 'Chapters (C)',
  tracks: 'Audio & Subtitles (A)',
  fullscreen: 'Full screen (F)',
  exitFullscreen: 'Exit full screen (F)',
  mute: 'Mute (M)',
  unmute: 'Unmute (M)',
  skipIntro: 'Skip Intro (S)',
  skipRecap: 'Skip Recap (S)',
};
