export const CLIENT_IMAGE_WIDTH = 64;
export const CLIENT_IMAGE_HEIGHT = 48;

/** Render a single character to a raw 8-bit grayscale base64 image (client-side fallback) */
export function buildClientImage(
  char: string,
  w = CLIENT_IMAGE_WIDTH,
  h = CLIENT_IMAGE_HEIGHT
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
  // Read red channel directly as 8-bit grayscale (1 byte per pixel)
  const bytes = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    bytes[i] = data[i * 4];
  }
  return btoa(String.fromCharCode(...bytes));
}

/** Convert a 1-bit packed mask (base64) to an 8-bit grayscale image (base64).
 *  Used for backward compat when the server still sends old format. */
export function mask1bitTo8bit(b64: string, w: number, h: number): string {
  const raw = atob(b64);
  const packed = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) packed[i] = raw.charCodeAt(i);
  const total = w * h;
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = ((packed[i >> 3] >> (7 - (i & 7))) & 1) * 255;
  }
  return btoa(String.fromCharCode(...out));
}

/** Apply random noise to an 8-bit grayscale image (base64 → base64).
 *  Adds ±15 per byte, clamped to [0, 255]. */
export function noisifyImage(b64: string, noiseRange = 15): string {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const val = raw.charCodeAt(i) + Math.round((Math.random() - 0.5) * 2 * noiseRange);
    out[i] = Math.max(0, Math.min(255, val));
  }
  return btoa(String.fromCharCode(...out));
}
