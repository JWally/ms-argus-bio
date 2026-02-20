/**
 * Shared 28x28 canvas preprocessing for MNIST/EMNIST inference.
 * Extracts the bounding box of drawn content (white-on-black),
 * centers it into a square crop, then renders into a 28×28 image.
 */

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Find bounding box of non-black pixels (channel > 20). */
function findBBox(data: Uint8ClampedArray, width: number, height: number): BBox | null {
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] > 20) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return minX > maxX || minY > maxY ? null : { minX, minY, maxX, maxY };
}

export interface RenderRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Render a source canvas region into a centered 28×28 output canvas.
 * Returns the output canvas (black background, content centered in 24×24 area).
 */
export function renderTo28x28(
  source: HTMLCanvasElement,
  region: RenderRegion,
  pad: number
): { outCanvas: HTMLCanvasElement; empty: boolean } {
  const { sx, sy, sw, sh } = region;
  const ctx = source.getContext('2d')!;
  const imageData = ctx.getImageData(sx, sy, sw, sh);
  const { data, width, height } = imageData;

  const bbox = findBBox(data, width, height);
  if (!bbox) return { outCanvas: make28x28(), empty: true };

  let { minX, minY, maxX, maxY } = bbox;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const size = Math.max(maxX - minX, maxY - minY, 30);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // If source region is offset, copy to a reusable temporary canvas first
  let drawSource: HTMLCanvasElement = source;
  let drawX = cx - size / 2 + sx;
  let drawY = cy - size / 2 + sy;
  if (sx !== 0 || sy !== 0 || sw !== source.width || sh !== source.height) {
    const tmp = getTmpRegion(sw, sh);
    tmp.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    drawSource = tmp;
    drawX = cx - size / 2;
    drawY = cy - size / 2;
  }

  const outCanvas = make28x28();
  outCanvas.getContext('2d')!.drawImage(drawSource, drawX, drawY, size, size, 2, 2, 24, 24);
  return { outCanvas, empty: false };
}

/** Reusable 28×28 output canvas — cleared on each call */
let _out28: HTMLCanvasElement | null = null;

function make28x28(): HTMLCanvasElement {
  if (!_out28) {
    _out28 = document.createElement('canvas');
    _out28.width = 28;
    _out28.height = 28;
  }
  const ctx = _out28.getContext('2d')!;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, 28, 28);
  return _out28;
}

/** Extract the preprocessed 28x28 grayscale image as a flat 784-element array.
 *  Returns raw 0-255 values (server normalizes internally). */
export function getImageData28x28(canvas: HTMLCanvasElement): number[] {
  const region = { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height };
  const { outCanvas, empty } = renderTo28x28(canvas, region, 20);
  if (empty) return new Array(784).fill(0);

  const outData = outCanvas.getContext('2d')!.getImageData(0, 0, 28, 28);
  const result: number[] = [];
  for (let i = 0; i < 784; i++) {
    result.push(outData.data[i * 4]); // 0-255 raw — server normalizes internally
  }
  return result;
}

/** Reusable temporary canvas for region extraction */
let _tmpRegion: HTMLCanvasElement | null = null;
let _tmpW = 0;
let _tmpH = 0;

function getTmpRegion(w: number, h: number): HTMLCanvasElement {
  if (!_tmpRegion || _tmpW !== w || _tmpH !== h) {
    _tmpRegion = _tmpRegion ?? document.createElement('canvas');
    _tmpRegion.width = w;
    _tmpRegion.height = h;
    _tmpW = w;
    _tmpH = h;
  }
  return _tmpRegion;
}
