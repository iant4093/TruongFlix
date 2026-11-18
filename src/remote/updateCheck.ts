import { useMusicPlayer } from '../music/player';

/**
 * Picks up a new version of the browser app after the PC's TruongFlix updates.
 *
 * A phone can keep the browser app (especially one added to the home screen) open for days without
 * reloading it, so it went on running the old version, and showing lyrics it had fetched before the
 * update, long after the desktop app had moved on. When the app comes back to the front (and every
 * so often), it compares its own script with the one the PC serves now, and reloads when they
 * differ, but only while nothing is playing, so music or a video is never cut off.
 */

/** The app's own script, which has a new name in every build. */
function scriptOf(doc: Document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return el ? new URL(el.getAttribute('src')!, location.href).pathname : null;
}

export async function serverHasNewVersion(): Promise<boolean> {
  const mine = scriptOf(document);
  if (!mine) return false;
  const res = await fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) return false;
  const theirs = scriptOf(new DOMParser().parseFromString(await res.text(), 'text/html'));
  return !!theirs && theirs !== mine;
}

const busy = () => useMusicPlayer.getState().playing || [...document.querySelectorAll('video, audio')].some((m) => !(m as HTMLMediaElement).paused);

let checking = false;
async function check() {
  if (checking || document.visibilityState !== 'visible' || busy()) return;
  checking = true;
  try {
    if ((await serverHasNewVersion()) && !busy()) location.reload();
  } catch {
    /* the PC isn't reachable right now: try again next time */
  } finally {
    checking = false;
  }
}

export function startUpdateCheck() {
  if (import.meta.env.DEV) return;
  document.addEventListener('visibilitychange', () => void check());
  window.setInterval(() => void check(), 10 * 60_000);
}
