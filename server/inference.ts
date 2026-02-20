// server/inference.ts
// Pure TypeScript CNN forward pass for EMNIST letter model.
// Zero external dependencies — runs in Lambda without TF.js.
//
// Supports both 26-class (A-Z) and 15-class (T3 pool) models.
// When a config.json exists in server/model/, uses its class mapping;
// otherwise falls back to 26-class behavior.
//
// Model architecture:
//   Input: [1, 28, 28, 1]
//     → Conv2D(32, 3×3, valid, relu)  → [1, 26, 26, 32]
//     → MaxPool2D(2×2)                → [1, 13, 13, 32]
//     → Conv2D(64, 3×3, valid, relu)  → [1, 11, 11, 64]
//     → MaxPool2D(2×2)                → [1, 5, 5, 64]
//     → Flatten                       → [1, 1600]
//     → Dense(128, relu)              → [1, 128]
//     → Dropout (no-op at inference)
//     → Dense(N, softmax)             → [1, N]  (N=26 or N=15)

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Model config (loaded at cold start) ──

interface ModelConfig {
  numClasses: number;
  letters: string[];
  alphabetIndices: number[]; // maps model output index → 0-25 alphabet index
}

function loadConfig(): ModelConfig {
  const configPath = join(__dirname, 'model', 'config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      numClasses: raw.numClasses,
      letters: raw.letters,
      alphabetIndices: raw.alphabetIndices,
    };
  }
  // Fallback: 26-class model (A-Z identity mapping)
  return {
    numClasses: 26,
    letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    alphabetIndices: Array.from({ length: 26 }, (_, i) => i),
  };
}

const CONFIG = loadConfig();

// ── Weight shapes (from weightsManifest) ──
// TF.js stores conv kernels as [kH, kW, inC, outC] and dense kernels as [inSize, outSize].
// dense2 shape depends on numClasses from config.
function buildWeightSpecs(numClasses: number) {
  return [
    { name: 'conv1_kernel', shape: [3, 3, 1, 32] },
    { name: 'conv1_bias', shape: [32] },
    { name: 'conv2_kernel', shape: [3, 3, 32, 64] },
    { name: 'conv2_bias', shape: [64] },
    { name: 'dense1_kernel', shape: [1600, 128] },
    { name: 'dense1_bias', shape: [128] },
    { name: 'dense2_kernel', shape: [128, numClasses] },
    { name: 'dense2_bias', shape: [numClasses] },
  ];
}

const WEIGHT_SPECS = buildWeightSpecs(CONFIG.numClasses);

interface ModelWeights {
  conv1_kernel: Float32Array;
  conv1_bias: Float32Array;
  conv2_kernel: Float32Array;
  conv2_bias: Float32Array;
  dense1_kernel: Float32Array;
  dense1_bias: Float32Array;
  dense2_kernel: Float32Array;
  dense2_bias: Float32Array;
}

function shapeSize(shape: number[]): number {
  let s = 1;
  for (const d of shape) s *= d;
  return s;
}

/** Parse weights.bin (consecutive float32 arrays in manifest order) into typed arrays. */
export function loadWeights(buf: Buffer): ModelWeights {
  const weights: Record<string, Float32Array> = {};
  let offset = 0;
  for (const spec of WEIGHT_SPECS) {
    const count = shapeSize(spec.shape);
    const byteLen = count * 4;
    // Copy to aligned buffer for Float32Array
    const aligned = new ArrayBuffer(byteLen);
    const view = new Uint8Array(aligned);
    view.set(buf.subarray(offset, offset + byteLen));
    weights[spec.name] = new Float32Array(aligned);
    offset += byteLen;
  }
  return weights as unknown as ModelWeights;
}

// ── Layer operations ──

interface ConvParams {
  input: Float32Array;
  kernel: Float32Array;
  bias: Float32Array;
  h: number;
  w: number;
  inC: number;
  outC: number;
  kSize: number;
}

/** Dot product of one kernel window at (oy,ox) for output channel oc. */
function kernelDot(p: ConvParams, oy: number, ox: number, oc: number): number {
  const { input, kernel, w, inC, outC, kSize } = p;
  let sum = 0;
  for (let ky = 0; ky < kSize; ky++) {
    for (let kx = 0; kx < kSize; kx++) {
      const inOff = ((oy + ky) * w + (ox + kx)) * inC;
      const kOff = (ky * kSize + kx) * inC * outC + oc;
      for (let ic = 0; ic < inC; ic++) {
        sum += input[inOff + ic] * kernel[kOff + ic * outC];
      }
    }
  }
  return sum;
}

/** Conv2D with valid padding + ReLU activation.
 *  input:  flat array in NHWC layout [h, w, inC]
 *  kernel: TF.js format [kH, kW, inC, outC]
 *  Returns flat array [outH, outW, outC]. */
function conv2dRelu(p: ConvParams): Float32Array {
  const outH = p.h - p.kSize + 1;
  const outW = p.w - p.kSize + 1;
  const output = new Float32Array(outH * outW * p.outC);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      for (let oc = 0; oc < p.outC; oc++) {
        const val = kernelDot(p, oy, ox, oc) + p.bias[oc];
        output[(oy * outW + ox) * p.outC + oc] = val > 0 ? val : 0;
      }
    }
  }

  return output;
}

/** MaxPool2D with 2×2 pool size, stride 2, valid padding.
 *  input: flat [h, w, channels] → output: flat [h/2, w/2, channels] */
function maxPool2d(input: Float32Array, h: number, w: number, channels: number): Float32Array {
  const outH = Math.floor(h / 2);
  const outW = Math.floor(w / 2);
  const output = new Float32Array(outH * outW * channels);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      for (let c = 0; c < channels; c++) {
        const iy = oy * 2;
        const ix = ox * 2;
        const v00 = input[(iy * w + ix) * channels + c];
        const v01 = input[(iy * w + ix + 1) * channels + c];
        const v10 = input[((iy + 1) * w + ix) * channels + c];
        const v11 = input[((iy + 1) * w + ix + 1) * channels + c];
        output[(oy * outW + ox) * channels + c] = Math.max(v00, v01, v10, v11);
      }
    }
  }

  return output;
}

/** Dense (fully connected) layer: output = input * kernel + bias.
 *  kernel: [inSize, outSize], input: [inSize], output: [outSize] */
function dense(
  input: Float32Array,
  kernel: Float32Array,
  bias: Float32Array,
  inSize: number,
  outSize: number
): Float32Array {
  const output = new Float32Array(outSize);
  for (let o = 0; o < outSize; o++) {
    let sum = bias[o];
    for (let i = 0; i < inSize; i++) {
      sum += input[i] * kernel[i * outSize + o];
    }
    output[o] = sum;
  }
  return output;
}

/** ReLU activation in-place */
function relu(arr: Float32Array): Float32Array {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < 0) arr[i] = 0;
  }
  return arr;
}

/** Softmax: normalized exponentials */
function softmax(input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  let max = -Infinity;
  for (let i = 0; i < input.length; i++) {
    if (input[i] > max) max = input[i];
  }
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    output[i] = Math.exp(input[i] - max);
    sum += output[i];
  }
  for (let i = 0; i < input.length; i++) {
    output[i] /= sum;
  }
  return output;
}

// ── Singleton model ──

let cachedWeights: ModelWeights | null = null;

function getWeights(): ModelWeights {
  if (!cachedWeights) {
    const weightsPath = join(__dirname, 'model', 'weights.bin');
    const buf = readFileSync(weightsPath);
    cachedWeights = loadWeights(buf);
  }
  return cachedWeights;
}

export interface InferenceResult {
  index: number; // top-1 alphabet index (0-25 → A-Z)
  confidence: number; // softmax probability of top-1
  allConfidences: number[]; // full 26-element softmax (zeros for non-pool letters in 15-class mode)
}

/** Run the EMNIST letter CNN on a 28×28 grayscale image.
 *  imageData: 784 values in [0, 255] (row-major, single channel). */
export function inferLetter(imageData: number[]): InferenceResult {
  const w = getWeights();
  const numClasses = CONFIG.numClasses;

  // Normalize to [0, 1]
  const input = new Float32Array(784);
  for (let i = 0; i < 784; i++) {
    input[i] = (imageData[i] ?? 0) / 255;
  }

  // Conv2D(32, 3×3, valid, relu): [28,28,1] → [26,26,32]
  const conv1 = conv2dRelu({
    input,
    kernel: w.conv1_kernel,
    bias: w.conv1_bias,
    h: 28,
    w: 28,
    inC: 1,
    outC: 32,
    kSize: 3,
  });

  // MaxPool2D(2×2): [26,26,32] → [13,13,32]
  const pool1 = maxPool2d(conv1, 26, 26, 32);

  // Conv2D(64, 3×3, valid, relu): [13,13,32] → [11,11,64]
  const conv2 = conv2dRelu({
    input: pool1,
    kernel: w.conv2_kernel,
    bias: w.conv2_bias,
    h: 13,
    w: 13,
    inC: 32,
    outC: 64,
    kSize: 3,
  });

  // MaxPool2D(2×2): [11,11,64] → [5,5,64]
  const pool2 = maxPool2d(conv2, 11, 11, 64);

  // Flatten: [5,5,64] → [1600]

  // Dense(128, relu): [1600] → [128]
  const dense1 = relu(dense(pool2, w.dense1_kernel, w.dense1_bias, 1600, 128));

  // Dropout: no-op at inference

  // Dense(N, softmax): [128] → [N]
  const logits = dense(dense1, w.dense2_kernel, w.dense2_bias, 128, numClasses);
  const probs = softmax(logits);

  // Map model output → 26-element alphabet confidences
  const allConfidences = new Array<number>(26).fill(0);
  for (let i = 0; i < numClasses; i++) {
    allConfidences[CONFIG.alphabetIndices[i]] = probs[i];
  }

  // Find top-1 (in model space, then map to alphabet index)
  let bestModelIdx = 0;
  let bestConf = probs[0];
  for (let i = 1; i < numClasses; i++) {
    if (probs[i] > bestConf) {
      bestModelIdx = i;
      bestConf = probs[i];
    }
  }

  return {
    index: CONFIG.alphabetIndices[bestModelIdx],
    confidence: bestConf,
    allConfidences,
  };
}
