import { useLibraryStore } from '../store/useLibraryStore';

/**
 * Coalesces library reloads during long jobs: at most one every `intervalMs` (trailing),
 * never overlapping. `flush()` cancels any pending reload and runs a final one.
 */
export function createReloadThrottle(intervalMs = 2000, reload: () => Promise<void> = () => useLibraryStore.getState().reload()) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let dirty = false;

  const run = async () => {
    timer = null;
    if (running) {
      dirty = true;
      return running;
    }
    last = Date.now();
    running = reload()
      .catch((e) => console.warn('[library] reload failed', e))
      .finally(() => {
        running = null;
        if (dirty) {
          dirty = false;
          request();
        }
      });
    return running;
  };

  function request() {
    if (timer != null) return;
    const wait = Math.max(0, last + intervalMs - Date.now());
    timer = setTimeout(() => void run(), wait);
  }

  async function flush() {
    if (timer != null) clearTimeout(timer);
    timer = null;
    dirty = false;
    if (running) await running;
    dirty = false;
    if (timer != null) clearTimeout(timer);
    timer = null;
    last = Date.now();
    await reload();
  }

  function cancel() {
    if (timer != null) clearTimeout(timer);
    timer = null;
    dirty = false;
  }

  return { request, flush, cancel };
}
