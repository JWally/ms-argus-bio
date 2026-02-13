import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { createGunzip } from 'zlib';
import { execSync } from 'child_process';
import path from 'path';
import * as tf from '@tensorflow/tfjs-node';

// EMNIST dataset — individual file URLs are dead, must download full archive
const EMNIST_ZIP_URL = 'https://biometrics.nist.gov/cs_links/EMNIST/gzip.zip';
const CACHE_DIR = path.resolve('.emnist-cache');

const FILES = {
  trainImages: 'emnist-letters-train-images-idx3-ubyte.gz',
  trainLabels: 'emnist-letters-train-labels-idx1-ubyte.gz',
  testImages: 'emnist-letters-test-images-idx3-ubyte.gz',
  testLabels: 'emnist-letters-test-labels-idx1-ubyte.gz',
};

const NUM_CLASSES = 26; // A-Z

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

  // Check if all 4 files already exist
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

  // Extract only the letters files we need
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
 * CRITICAL: EMNIST images are stored transposed relative to MNIST.
 * Each 28x28 image needs to be transposed (rows ↔ cols) for correct orientation.
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
 * CRITICAL: EMNIST letters labels are 1-indexed (1=A, 2=B, ..., 26=Z).
 * Subtract 1 to get 0-indexed labels for one-hot encoding.
 */
function parseLabels(buffer: Buffer): Uint8Array {
  const numLabels = buffer.readUInt32BE(4);
  console.log(`  Labels: ${numLabels}`);
  const raw = new Uint8Array(buffer.buffer, buffer.byteOffset + 8, numLabels);
  // Convert from 1-indexed to 0-indexed
  const labels = new Uint8Array(numLabels);
  for (let i = 0; i < numLabels; i++) {
    labels[i] = raw[i] - 1;
  }
  return labels;
}

function oneHot(labels: Uint8Array, numClasses: number): Float32Array {
  const result = new Float32Array(labels.length * numClasses);
  for (let i = 0; i < labels.length; i++) {
    result[i * numClasses + labels[i]] = 1;
  }
  return result;
}

async function main() {
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

  const numTrain = trainLabels.length;
  const numTest = testLabels.length;
  console.log(`  Train: ${numTrain}, Test: ${numTest}`);

  const trainXs = tf.tensor4d(trainImages, [numTrain, 28, 28, 1]);
  const trainYs = tf.tensor2d(oneHot(trainLabels, NUM_CLASSES), [numTrain, NUM_CLASSES]);
  const testXs = tf.tensor4d(testImages, [numTest, 28, 28, 1]);
  const testYs = tf.tensor2d(oneHot(testLabels, NUM_CLASSES), [numTest, NUM_CLASSES]);

  console.log('\nBuilding model (26-class CNN)...');
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

  const epochs = 15;
  console.log(`\nTraining on ${numTrain} images (${epochs} epochs)...\n`);
  await model.fit(trainXs, trainYs, {
    epochs,
    batchSize: 128,
    validationData: [testXs, testYs],
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        console.log(
          `  Epoch ${epoch + 1}/${epochs} — ` +
            `loss: ${logs!.loss.toFixed(4)}, acc: ${(logs!.acc * 100).toFixed(1)}% | ` +
            `val_loss: ${logs!.val_loss.toFixed(4)}, val_acc: ${(logs!.val_acc * 100).toFixed(1)}%`
        );
      },
    },
  });

  const result = model.evaluate(testXs, testYs) as tf.Tensor[];
  const testAcc = (await result[1].data())[0];
  console.log(`\nFinal test accuracy: ${(testAcc * 100).toFixed(2)}%`);

  const modelDir = path.resolve('public/model-emnist');
  await mkdir(modelDir, { recursive: true });
  await model.save(`file://${modelDir}`);
  console.log(`Model saved to ${modelDir}/`);

  trainXs.dispose();
  trainYs.dispose();
  testXs.dispose();
  testYs.dispose();
  for (const t of result) t.dispose();
}

main().catch(console.error);
