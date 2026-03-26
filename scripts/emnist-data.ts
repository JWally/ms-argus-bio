// scripts/emnist-data.ts
// Shared EMNIST data loading utilities

import { mkdir, writeFile, access } from 'fs/promises';
import { createGunzip } from 'zlib';
import { execSync } from 'child_process';
import path from 'path';

const EMNIST_ZIP_URL = 'https://biometrics.nist.gov/cs_links/EMNIST/gzip.zip';
export const CACHE_DIR = path.resolve('.emnist-cache');

export const FILES = {
  trainImages: 'emnist-letters-train-images-idx3-ubyte.gz',
  trainLabels: 'emnist-letters-train-labels-idx1-ubyte.gz',
  testImages: 'emnist-letters-test-images-idx3-ubyte.gz',
  testLabels: 'emnist-letters-test-labels-idx1-ubyte.gz',
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Download the full gzip.zip archive if not cached, extract the 4 letters files */
export async function ensureDataFiles(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const allExist = await Promise.all(
    Object.values(FILES).map((f) => fileExists(path.join(CACHE_DIR, f)))
  );
  if (allExist.every(Boolean)) {
    console.log('  Using cached EMNIST files');
    return;
  }

  const zipPath = path.join(CACHE_DIR, 'gzip.zip');

  if (!(await fileExists(zipPath))) {
    console.log(`  Downloading ${EMNIST_ZIP_URL} (~561MB)...`);
    const response = await fetch(EMNIST_ZIP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, buf);
    console.log('  Download complete');
  }

  console.log('  Extracting letters files from archive...');
  const filesToExtract = Object.values(FILES).map((f) => `gzip/${f}`);
  execSync(`unzip -jo "${zipPath}" ${filesToExtract.join(' ')} -d "${CACHE_DIR}"`, {
    stdio: 'inherit',
  });
}

export function gunzipBuffer(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });
}

/**
 * Parse IDX image file.
 * EMNIST images are stored transposed relative to MNIST — each 28x28 image
 * needs to be transposed (rows ↔ cols) for correct orientation.
 */
export function parseImages(buffer: Buffer): Float32Array {
  const numImages = buffer.readUInt32BE(4);
  const rows = buffer.readUInt32BE(8);
  const cols = buffer.readUInt32BE(12);
  console.log(`  Images: ${numImages} x ${rows}x${cols}`);

  const pixels = new Float32Array(numImages * rows * cols);
  const headerOffset = 16;

  for (let n = 0; n < numImages; n++) {
    const imgOffset = n * rows * cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const srcIdx = headerOffset + imgOffset + r * cols + c;
        const dstIdx = imgOffset + c * rows + r;
        pixels[dstIdx] = buffer[srcIdx] / 255;
      }
    }
  }
  return pixels;
}

/**
 * Parse IDX label file.
 * EMNIST letters labels are 1-indexed (1=A, 2=B, ..., 26=Z).
 * Returns 0-indexed labels (0=A, 1=B, ..., 25=Z).
 */
export function parseLabels(buffer: Buffer): Uint8Array {
  const numLabels = buffer.readUInt32BE(4);
  console.log(`  Labels: ${numLabels}`);
  const raw = new Uint8Array(buffer.buffer, buffer.byteOffset + 8, numLabels);
  const labels = new Uint8Array(numLabels);
  for (let i = 0; i < numLabels; i++) {
    labels[i] = raw[i] - 1; // 1-indexed → 0-indexed
  }
  return labels;
}

export function oneHot(labels: Uint8Array, numClasses: number): Float32Array {
  const result = new Float32Array(labels.length * numClasses);
  for (let i = 0; i < labels.length; i++) {
    result[i * numClasses + labels[i]] = 1;
  }
  return result;
}
