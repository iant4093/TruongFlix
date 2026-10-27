/** Tiny client for the TruongFlix media server's `/api`. */

const TOKEN = 'tf-remote-token';

export class AuthError extends Error {}

export const getToken = () => localStorage.getItem(TOKEN) ?? '';
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN, t) : localStorage.removeItem(TOKEN));

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-TF-Token': getToken() },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken('');
    throw new AuthError(data.error ?? 'Sign in again');
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
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

export function fmtTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
