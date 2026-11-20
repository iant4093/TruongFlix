import { timeoutSignal } from '../lib/timeout';

/** Tiny client for the TruongFlix media server's `/api`. */

const TOKEN = 'tf-remote-token';

export class AuthError extends Error {}

/** Fired on `window` when the media server no longer accepts this browser's sign-in. */
export const SIGNED_OUT = 'tf-signed-out';

/** A refused request, with its HTTP status (e.g. 403 "Playing on another profile"). */
export class ApiStatusError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const getToken = () => localStorage.getItem(TOKEN) ?? '';
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN, t) : localStorage.removeItem(TOKEN));

/** `keepalive`: the request still completes if the page is closing (saving progress on the way out). */
/** `timeout`: give up after this many ms (default 45 s). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean; timeout?: number } = {}): Promise<T> {
  // A PC that went away mid-request (asleep, off the Wi-Fi) can leave a request hanging for minutes;
  // giving up counts as being offline (downloads pause and resume later, progress is queued).
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-TF-Token': getToken() },
    body: init.body ? JSON.stringify(init.body) : undefined,
    keepalive: init.keepalive,
    signal: init.keepalive ? undefined : timeoutSignal(init.timeout ?? 45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken('');
    window.dispatchEvent(new Event(SIGNED_OUT));
    throw new AuthError(data.error ?? 'Sign in again');
  }
  if (!res.ok) throw new ApiStatusError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function login(code: string) {
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Wrong code');
  setToken(data.token);
}

export const qs = (params: Record<string, string | number | null | undefined>) =>
  '?' +
  Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
