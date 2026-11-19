/**
 * An abort signal that fires after `ms`. `AbortSignal.timeout` only exists from Safari 16, and the
 * Mac app runs on older WebKit too (macOS 10.15/11), where calling it threw and every TMDB, OMDb
 * and TVmaze request failed.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('The request took too long', 'TimeoutError')), ms);
  return controller.signal;
}
