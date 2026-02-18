export const CLIENT_MASK_WIDTH = 64;
export const CLIENT_MASK_HEIGHT = 48;

/** Render a single character to a 1-bit packed base64 mask (client-side fallback) */
export function buildClientMask(
  char: string,
  w = CLIENT_MASK_WIDTH,
  h = CLIENT_MASK_HEIGHT
): string {
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${h * 0.72}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, w / 2, h / 2 + 1);
  const data = ctx.getImageData(0, 0, w, h).data;
  const bytes = new Uint8Array(Math.ceil((w * h) / 8));
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4] > 128) {
      bytes[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
    }
  }
  return btoa(String.fromCharCode(...bytes));
}

/** Apply random bit-flip noise to a 1-bit packed mask (base64 → base64).
 *  Browser equivalent of the server's Node Buffer version. */
export function noisifyMask(
  b64: string,
  w = CLIENT_MASK_WIDTH,
  h = CLIENT_MASK_HEIGHT,
  noiseRate = 0.03
): string {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  const totalBits = w * h;
  const flips = Math.round(totalBits * noiseRate);
  for (let f = 0; f < flips; f++) {
    const bit = Math.floor(Math.random() * totalBits);
    const byteIdx = Math.floor(bit / 8);
    const bitIdx = 7 - (bit % 8);
    out[byteIdx] ^= 1 << bitIdx;
  }
  return btoa(String.fromCharCode(...out));
}
