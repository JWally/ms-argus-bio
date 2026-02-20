import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { createGunzip } from 'zlib';
import { execSync } from 'child_process';
import path from 'path';
import * as tf from '@tensorflow/tfjs-node';

// ── Target classes: 15 letters used in T3 challenges ──
const TARGET_LETTERS = [
  'A',
  'C',
  'E',
  'F',
  'H',
  'J',
  'K',
  'M',
  'N',
  'P',
  'R',
  'T',
  'W',
  'X',
  'Y',
] as const;
// EMNIST labels are 1-indexed (A=1..Z=26), so 0-indexed: A=0, C=2, E=4, ...
const TARGET_EMNIST_INDICES = [0, 2, 4, 5, 7, 9, 10, 12, 13, 15, 17, 19, 22, 23, 24];
const NUM_CLASSES = 15;

// Build reverse lookup: emnist 0-indexed label → model class index (or -1 if not in pool)
const EMNIST_TO_MODEL = new Int8Array(26).fill(-1);
for (let i = 0; i < TARGET_EMNIST_INDICES.length; i++) {
  EMNIST_TO_MODEL[TARGET_EMNIST_INDICES[i]] = i;
}

// EMNIST dataset
const EMNIST_ZIP_URL = 'https://biometrics.nist.gov/cs_links/EMNIST/gzip.zip';
const CACHE_DIR = path.resolve('.emnist-cache');

const FILES = {
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
async function ensureDataFiles(): Promise<void> {
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

function gunzipBuffer(compressed: Buffer): Promise<Buffer> {
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
function parseImages(buffer: Buffer): Float32Array {
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
        // Transpose: swap row and col when reading
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
function parseLabels(buffer: Buffer): Uint8Array {
  const numLabels = buffer.readUInt32BE(4);
  console.log(`  Labels: ${numLabels}`);
  const raw = new Uint8Array(buffer.buffer, buffer.byteOffset + 8, numLabels);
  const labels = new Uint8Array(numLabels);
  for (let i = 0; i < numLabels; i++) {
    labels[i] = raw[i] - 1; // 1-indexed → 0-indexed
  }
  return labels;
}

/**
 * Filter images+labels to only target classes, remap labels to 0..14.
 * Returns { images: Float32Array (N*784), labels: Uint8Array (N), count: number }
 */
function filterAndRemap(
  images: Float32Array,
  labels: Uint8Array
): { images: Float32Array; labels: Uint8Array; count: number } {
  const total = labels.length;

  // First pass: count matching samples
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (EMNIST_TO_MODEL[labels[i]] >= 0) count++;
  }

  const filteredImages = new Float32Array(count * 784);
  const filteredLabels = new Uint8Array(count);
  let idx = 0;

  for (let i = 0; i < total; i++) {
    const modelIdx = EMNIST_TO_MODEL[labels[i]];
    if (modelIdx >= 0) {
      filteredImages.set(images.subarray(i * 784, (i + 1) * 784), idx * 784);
      filteredLabels[idx] = modelIdx;
      idx++;
    }
  }

  return { images: filteredImages, labels: filteredLabels, count };
}

function oneHot(labels: Uint8Array, numClasses: number): Float32Array {
  const result = new Float32Array(labels.length * numClasses);
  for (let i = 0; i < labels.length; i++) {
    result[i * numClasses + labels[i]] = 1;
  }
  return result;
}

/**
 * Data augmentation layer:
 *  - Gaussian noise (σ=0.04)
 *  - Random translation (±3px via pad + cropAndResize)
 */
function augment(images: tf.Tensor4D): tf.Tensor4D {
  return tf.tidy(() => {
    const [n, h, w, c] = images.shape;
    const pad = 3;

    // Pad images by 3px on each side
    const padded = images.pad([
      [0, 0],
      [pad, pad],
      [pad, pad],
      [0, 0],
    ]) as tf.Tensor4D;

    // Random crop back to 28x28 (equivalent to random ±3px translation)
    const paddedH = h + 2 * pad; // 34
    const paddedW = w + 2 * pad; // 34

    // Generate random offsets for each image
    const offsetY = tf.randomUniform([n], 0, 2 * pad + 1, 'int32');
    const offsetX = tf.randomUniform([n], 0, 2 * pad + 1, 'int32');

    const offsetYArr = offsetY.dataSync();
    const offsetXArr = offsetX.dataSync();

    // Build crop boxes [y1, x1, y2, x2] normalized to [0,1]
    const boxes = new Float32Array(n * 4);
    const boxInd = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const y1 = offsetYArr[i] / paddedH;
      const x1 = offsetXArr[i] / paddedW;
      const y2 = (offsetYArr[i] + h) / paddedH;
      const x2 = (offsetXArr[i] + w) / paddedW;
      boxes[i * 4] = y1;
      boxes[i * 4 + 1] = x1;
      boxes[i * 4 + 2] = y2;
      boxes[i * 4 + 3] = x2;
      boxInd[i] = i;
    }

    const cropped = tf.image.cropAndResize(
      padded,
      tf.tensor2d(boxes, [n, 4]),
      tf.tensor1d(boxInd, 'int32'),
      [h, w]
    );

    // Add Gaussian noise
    const noise = tf.randomNormal([n, h, w, c], 0, 0.04);
    const noisy = cropped.add(noise).clipByValue(0, 1) as tf.Tensor4D;

    offsetY.dispose();
    offsetX.dispose();

    return noisy;
  });
}

async function main() {
  console.log('=== Training 15-class EMNIST model for T3 ===');
  console.log(`Target letters: ${TARGET_LETTERS.join(', ')}\n`);

  console.log('Preparing EMNIST Letters dataset...');
  await ensureDataFiles();

  console.log('\nDecompressing...');
  const [trainImgBuf, trainLblBuf, testImgBuf, testLblBuf] = await Promise.all(
    [FILES.trainImages, FILES.trainLabels, FILES.testImages, FILES.testLabels].map(async (f) => {
      const gz = await readFile(path.join(CACHE_DIR, f));
      return gunzipBuffer(gz);
    })
  );

  console.log('\nParsing (with transpose)...');
  const trainImages = parseImages(trainImgBuf);
  const trainLabels = parseLabels(trainLblBuf);
  const testImages = parseImages(testImgBuf);
  const testLabels = parseLabels(testLblBuf);

  console.log('\nFiltering to 15 target classes...');
  const train = filterAndRemap(trainImages, trainLabels);
  const test = filterAndRemap(testImages, testLabels);
  console.log(`  Train: ${train.count} (from ${trainLabels.length})`);
  console.log(`  Test: ${test.count} (from ${testLabels.length})`);

  // Print per-class sample counts
  const trainCounts = new Int32Array(NUM_CLASSES);
  for (let i = 0; i < train.count; i++) trainCounts[train.labels[i]]++;
  console.log('\n  Per-class training samples:');
  for (let i = 0; i < NUM_CLASSES; i++) {
    console.log(`    ${TARGET_LETTERS[i]}: ${trainCounts[i]}`);
  }

  const trainXs = tf.tensor4d(train.images, [train.count, 28, 28, 1]);
  const trainYs = tf.tensor2d(oneHot(train.labels, NUM_CLASSES), [train.count, NUM_CLASSES]);
  const testXs = tf.tensor4d(test.images, [test.count, 28, 28, 1]);
  const testYs = tf.tensor2d(oneHot(test.labels, NUM_CLASSES), [test.count, NUM_CLASSES]);

  console.log('\nBuilding model (15-class CNN)...');
  const model = tf.sequential();
  model.add(
    tf.layers.conv2d({
      inputShape: [28, 28, 1],
      filters: 32,
      kernelSize: 3,
      activation: 'relu',
    })
  );
  model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
  model.add(tf.layers.conv2d({ filters: 64, kernelSize: 3, activation: 'relu' }));
  model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dense({ units: 128, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.25 }));
  model.add(tf.layers.dense({ units: NUM_CLASSES, activation: 'softmax' }));

  model.compile({
    optimizer: tf.train.adam(),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  model.summary();

  await trainWithEarlyStopping({
    model,
    trainXs,
    trainYs,
    testXs,
    testYs,
    trainCount: train.count,
  });
  await evaluateAndSave(model, testXs, testYs, test.count);

  // Cleanup tensors
  trainXs.dispose();
  trainYs.dispose();
  testXs.dispose();
  testYs.dispose();
}

interface TrainOpts {
  model: tf.Sequential;
  trainXs: tf.Tensor4D;
  trainYs: tf.Tensor2D;
  testXs: tf.Tensor4D;
  testYs: tf.Tensor2D;
  trainCount: number;
}

function snapshotWeights(model: tf.Sequential, prev: tf.NamedTensorMap | null): tf.NamedTensorMap {
  if (prev) {
    for (const t of Object.values(prev)) t.dispose();
  }
  const snap: tf.NamedTensorMap = {};
  for (const w of model.weights) {
    snap[w.name] = w.read().clone();
  }
  return snap;
}

function restoreWeights(model: tf.Sequential, weights: tf.NamedTensorMap) {
  for (const w of model.weights) {
    if (weights[w.name]) w.write(weights[w.name]);
  }
  for (const t of Object.values(weights)) t.dispose();
}

async function trainWithEarlyStopping(opts: TrainOpts) {
  const { model, trainXs, trainYs, testXs, testYs, trainCount } = opts;
  const maxEpochs = 50;
  const patience = 10;
  const batchSize = 128;

  let bestValAcc = 0;
  let bestWeights: tf.NamedTensorMap | null = null;
  let waitCount = 0;

  console.log(
    `\nTraining on ${trainCount} images (up to ${maxEpochs} epochs, early stopping patience=${patience})...\n`
  );

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const augTrainXs = augment(trainXs);
    const history = await model.fit(augTrainXs, trainYs, {
      epochs: 1,
      batchSize,
      validationData: [testXs, testYs],
      verbose: 0,
    });
    augTrainXs.dispose();

    const valAcc = history.history.val_acc[0] as number;
    const improved = valAcc > bestValAcc;
    const loss = (history.history.loss[0] as number).toFixed(4);
    const acc = ((history.history.acc[0] as number) * 100).toFixed(1);
    const valLoss = (history.history.val_loss[0] as number).toFixed(4);
    console.log(
      `  Epoch ${epoch + 1}/${maxEpochs} — loss: ${loss}, acc: ${acc}% | val_loss: ${valLoss}, val_acc: ${(valAcc * 100).toFixed(1)}%${improved ? ' ★' : ''}`
    );

    if (improved) {
      bestValAcc = valAcc;
      bestWeights = snapshotWeights(model, bestWeights);
      waitCount = 0;
      continue;
    }
    waitCount++;
    if (waitCount >= patience) {
      console.log(
        `\n  Early stopping at epoch ${epoch + 1} (no improvement for ${patience} epochs)`
      );
      break;
    }
  }

  if (bestWeights) {
    console.log(`\nRestoring best weights (val_acc: ${(bestValAcc * 100).toFixed(1)}%)...`);
    restoreWeights(model, bestWeights);
  }
}

async function evaluateAndSave(
  model: tf.Sequential,
  testXs: tf.Tensor4D,
  testYs: tf.Tensor2D,
  testCount: number
) {
  const result = model.evaluate(testXs, testYs) as tf.Tensor[];
  const testAcc = (await result[1].data())[0];
  console.log(`\nFinal test accuracy: ${(testAcc * 100).toFixed(2)}%`);

  console.log('\nPer-class accuracy:');
  const predictions = model.predict(testXs) as tf.Tensor;
  const predIndices = predictions.argMax(-1).dataSync();
  const trueIndices = testYs.argMax(-1).dataSync();

  const classCorrect = new Int32Array(NUM_CLASSES);
  const classTotal = new Int32Array(NUM_CLASSES);
  const confusionCounts: Record<string, number> = {};

  for (let i = 0; i < testCount; i++) {
    const trueClass = trueIndices[i];
    const predClass = predIndices[i];
    classTotal[trueClass]++;
    if (predClass === trueClass) {
      classCorrect[trueClass]++;
    } else {
      const key = `${TARGET_LETTERS[trueClass]}→${TARGET_LETTERS[predClass]}`;
      confusionCounts[key] = (confusionCounts[key] || 0) + 1;
    }
  }

  for (let i = 0; i < NUM_CLASSES; i++) {
    const acc = classTotal[i] > 0 ? ((classCorrect[i] / classTotal[i]) * 100).toFixed(1) : 'N/A';
    console.log(`  ${TARGET_LETTERS[i]}: ${acc}% (${classCorrect[i]}/${classTotal[i]})`);
  }

  const confusionPairs = Object.entries(confusionCounts).sort((a, b) => b[1] - a[1]);
  console.log('\nTop confusion pairs:');
  for (const [pair, count] of confusionPairs.slice(0, 10)) {
    console.log(`  ${pair}: ${count}`);
  }

  const modelDir = path.resolve('server/model');
  await mkdir(modelDir, { recursive: true });
  await model.save(`file://${modelDir}`);
  console.log(`\nModel saved to ${modelDir}/`);

  const config = {
    numClasses: NUM_CLASSES,
    letters: [...TARGET_LETTERS],
    alphabetIndices: TARGET_EMNIST_INDICES,
  };
  await writeFile(path.join(modelDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log(`Config saved to ${modelDir}/config.json`);

  predictions.dispose();
  for (const t of result) t.dispose();
}

main().catch(console.error);
