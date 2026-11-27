/** A picture the user picked for a playlist cover, made ready to save. */

/** Pictures up to this size are kept as they are. */
const KEEP_AS_IS = 1_500_000;
/** Larger ones are scaled down to fit this square (plenty for a cover)… */
const MAX_SIDE = 1200;
/** …and one that can't be scaled down (no canvas) is refused above this (the browser app sends it over the network). */
const MAX_BYTES = 2_500_000;

const readBytes = async (file: Blob): Promise<Uint8Array> =>
  new Uint8Array(
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        }),
  );

async function scaledDown(file: Blob): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return blob ? readBytes(blob) : null;
  } catch {
    return null;
  }
}

/** The picture's bytes: as they are when small, else scaled down to a JPEG. */
export async function coverBytes(file: Blob): Promise<Uint8Array> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('Pick a picture');
  const raw = await readBytes(file);
  if (raw.length <= KEEP_AS_IS) return raw;
  const small = await scaledDown(file);
  if (small && small.length < raw.length) return small;
  if (raw.length > MAX_BYTES) throw new Error('This picture is too big');
  return raw;
}
