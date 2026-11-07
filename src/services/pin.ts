/**
 * Profile PINs are stored as `pbkdf2$<iterations>$<salt b64>$<hash b64>` (PBKDF2-SHA256, 16-byte
 * random salt). Databases from before hashing hold the bare 4 digits until startup migrates them.
 */

const ITERATIONS = 150_000;
const MAX_ITERATIONS = 5_000_000;

export const isPlainPin = (value: string) => /^\d{4}$/.test(value);
export const isHashedPin = (value: string) => value.startsWith('pbkdf2$');

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

export async function hashPin(pin: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(await derive(pin, salt, iterations))}`;
}

/** The value to store for a PIN field: new 4-digit PINs are hashed, stored hashes and '' pass through. */
export const storedPin = async (value: string) => (isPlainPin(value) ? hashPin(value) : value);

/** Whether `entered` matches a stored PIN (hashed, or plaintext not yet migrated). */
export async function verifyPin(stored: string | null | undefined, entered: string): Promise<boolean> {
  if (!stored || !entered) return false;
  const enc = new TextEncoder();
  if (!isHashedPin(stored)) return isPlainPin(stored) && sameBytes(enc.encode(stored), enc.encode(entered));
  const [, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS || !salt || !hash) return false;
  try {
    return sameBytes(await derive(entered, fromB64(salt), iterations), fromB64(hash));
  } catch {
    return false;
  }
}

/** Whether any of the stored PINs matches. */
export async function verifyAnyPin(stored: (string | null | undefined)[], entered: string): Promise<boolean> {
  for (const pin of stored) if (await verifyPin(pin, entered)) return true;
  return false;
}
