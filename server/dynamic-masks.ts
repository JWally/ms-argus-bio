// server/dynamic-masks.ts
// Runtime dynamic mask generation: picks a random font variant and applies
// geometric transforms (rotation, scale, jitter, elastic deformation) so every
// mask served is structurally unique. Defeats Hamming-distance template matching.

import { GLYPH_VARIANTS, MASK_WIDTH, MASK_HEIGHT } from './glyph-masks';

const W = MASK_WIDTH;
const H = MASK_HEIGHT;
const TOTAL = W * H;

/** Unpack base64-encoded 1-bit mask into a float array (0.0 or 1.0 per pixel) */
function unpack(b64: string): Float32Array {
  const raw = Buffer.from(b64, 'base64');
  const out = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    const byteIdx = i >> 3;
    const bitIdx = 7 - (i & 7);
    out[i] = (raw[byteIdx] >> bitIdx) & 1;
  }
  return out;
}

/** Pack float array (thresholded at 0.5) back to base64-encoded 1-bit mask */
function pack(pixels: Float32Array): string {
  const bytes = Buffer.alloc(Math.ceil(TOTAL / 8));
  for (let i = 0; i < TOTAL; i++) {
    if (pixels[i] >= 0.5) {
      bytes[i >> 3] |= 1 << (7 - (i & 7));
    }
  }
  return bytes.toString('base64');
}

interface AffineOpts {
  src: Float32Array;
  angle: number;
  scale: number;
  dx: number;
  dy: number;
}

/** Apply affine transform with bilinear interpolation.
 *  Transforms are applied as inverse mapping: for each output pixel,
 *  we compute where it came from in the source. */
function affineTransform({ src, angle, scale, dx, dy }: AffineOpts): Float32Array {
  const dst = new Float32Array(TOTAL);
  const cx = W / 2;
  const cy = H / 2;
  const cosA = Math.cos(-angle);
  const sinA = Math.sin(-angle);
  const invS = 1 / scale;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Translate to center, undo translation jitter
      const tx = (x - cx - dx) * invS;
      const ty = (y - cy - dy) * invS;

      // Inverse rotation
      const srcX = cosA * tx - sinA * ty + cx;
      const srcY = sinA * tx + cosA * ty + cy;

      // Bilinear interpolation
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      if (x0 < 0 || x1 >= W || y0 < 0 || y1 >= H) continue;

      const fx = srcX - x0;
      const fy = srcY - y0;
      const v00 = src[y0 * W + x0];
      const v10 = src[y0 * W + x1];
      const v01 = src[y1 * W + x0];
      const v11 = src[y1 * W + x1];

      dst[y * W + x] =
        v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }
  return dst;
}

/** Apply elastic deformation using a smoothed random displacement field.
 *  Uses box-blur smoothing for fast Gaussian approximation. */
function elasticDeform(src: Float32Array, strength: number): Float32Array {
  // Generate random displacement field
  const dxField = new Float32Array(TOTAL);
  const dyField = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    dxField[i] = (Math.random() - 0.5) * 2;
    dyField[i] = (Math.random() - 0.5) * 2;
  }

  // Smooth with 3 passes of box blur (approximates Gaussian, sigma ≈ kernel*sqrt(passes/3))
  const kernel = 4;
  boxBlur(dxField, W, H, kernel);
  boxBlur(dxField, W, H, kernel);
  boxBlur(dxField, W, H, kernel);
  boxBlur(dyField, W, H, kernel);
  boxBlur(dyField, W, H, kernel);
  boxBlur(dyField, W, H, kernel);

  // Scale to desired strength
  for (let i = 0; i < TOTAL; i++) {
    dxField[i] *= strength;
    dyField[i] *= strength;
  }

  // Apply displacement with bilinear interpolation
  const dst = new Float32Array(TOTAL);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const srcX = x + dxField[idx];
      const srcY = y + dyField[idx];

      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      if (x0 < 0 || x0 + 1 >= W || y0 < 0 || y0 + 1 >= H) continue;

      const fx = srcX - x0;
      const fy = srcY - y0;
      dst[idx] =
        src[y0 * W + x0] * (1 - fx) * (1 - fy) +
        src[y0 * W + x0 + 1] * fx * (1 - fy) +
        src[(y0 + 1) * W + x0] * (1 - fx) * fy +
        src[(y0 + 1) * W + x0 + 1] * fx * fy;
    }
  }
  return dst;
}

/** In-place horizontal then vertical box blur */
function boxBlur(data: Float32Array, w: number, h: number, radius: number): void {
  const tmp = new Float32Array(data.length);
  const diam = radius * 2 + 1;

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[y * w + Math.max(0, Math.min(w - 1, x))];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / diam;
      const addIdx = Math.min(w - 1, x + radius + 1);
      const subIdx = Math.max(0, x - radius);
      sum += data[y * w + addIdx] - data[y * w + subIdx];
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      data[y * w + x] = sum / diam;
      const addIdx = Math.min(h - 1, y + radius + 1);
      const subIdx = Math.max(0, y - radius);
      sum += tmp[addIdx * w + x] - tmp[subIdx * w + x];
    }
  }
}

/** Apply random bit-flip noise to the packed mask (same as old noisifyMask but on float array) */
function applyNoise(pixels: Float32Array, noiseRate: number): void {
  const flips = Math.round(TOTAL * noiseRate);
  for (let f = 0; f < flips; f++) {
    const idx = Math.floor(Math.random() * TOTAL);
    pixels[idx] = pixels[idx] >= 0.5 ? 0 : 1;
  }
}

/** Generate a dynamically transformed mask for a glyph character.
 *  Picks a random font variant and applies rotation, scale, jitter,
 *  elastic deformation, and bit-flip noise. */
export function generateDynamicMask(char: string): string {
  const variants = GLYPH_VARIANTS[char];
  if (!variants || variants.length === 0) {
    throw new Error(`No mask variants for glyph: ${char}`);
  }

  // Pick random font variant
  const variant = variants[Math.floor(Math.random() * variants.length)];
  let pixels = unpack(variant);

  // Random rotation ±12°
  const angle = (Math.random() - 0.5) * 24 * (Math.PI / 180);
  // Random scale 1.00–1.24
  const scale = 1.0 + Math.random() * 0.24;
  // Random position jitter ±2px
  const dx = (Math.random() - 0.5) * 4;
  const dy = (Math.random() - 0.5) * 4;

  pixels = affineTransform({ src: pixels, angle, scale, dx, dy });

  // Elastic deformation (strength 2.0–3.5px displacement)
  const elasticStrength = 2.0 + Math.random() * 1.5;
  pixels = elasticDeform(pixels, elasticStrength);

  // Bit-flip noise (3%)
  applyNoise(pixels, 0.03);

  return pack(pixels);
}

/** Generate a dynamically transformed 8-bit grayscale image for a glyph character.
 *  Same transform pipeline as generateDynamicMask but outputs raw 8-bit grayscale
 *  (1 byte per pixel) with anti-aliased edges, background noise, and intensity
 *  variation. Forces attackers to do real OCR instead of binary template matching. */
export function generateDynamicImage(char: string): string {
  const variants = GLYPH_VARIANTS[char];
  if (!variants || variants.length === 0) {
    throw new Error(`No image variants for glyph: ${char}`);
  }

  // Pick random font variant
  const variant = variants[Math.floor(Math.random() * variants.length)];
  let pixels = unpack(variant);

  // Random rotation ±12°
  const angle = (Math.random() - 0.5) * 24 * (Math.PI / 180);
  // Random scale 1.00–1.24
  const scale = 1.0 + Math.random() * 0.24;
  // Random position jitter ±2px
  const dx = (Math.random() - 0.5) * 4;
  const dy = (Math.random() - 0.5) * 4;

  pixels = affineTransform({ src: pixels, angle, scale, dx, dy });

  // Elastic deformation (strength 2.0–3.5px displacement)
  const elasticStrength = 2.0 + Math.random() * 1.5;
  pixels = elasticDeform(pixels, elasticStrength);

  // 1-pass box blur (radius 1) for anti-aliased edges
  boxBlur(pixels, W, H, 1);

  // Vary glyph intensity: multiply all foreground values by random factor in [0.7, 1.0]
  const intensity = 0.7 + Math.random() * 0.3;
  for (let i = 0; i < TOTAL; i++) {
    pixels[i] *= intensity;
  }

  // Add per-pixel background noise: += (random - 0.5) * 0.15, clamped to [0, 1]
  for (let i = 0; i < TOTAL; i++) {
    pixels[i] = Math.max(0, Math.min(1, pixels[i] + (Math.random() - 0.5) * 0.15));
  }

  // Pack as raw 8-bit grayscale (1 byte per pixel, 0-255)
  const bytes = Buffer.alloc(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    bytes[i] = Math.round(pixels[i] * 255);
  }
  return bytes.toString('base64');
}
