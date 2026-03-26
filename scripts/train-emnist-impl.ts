// scripts/train-emnist-impl.ts
// Shared EMNIST training implementation — called by train-emnist-15.ts and train-emnist-23.ts

import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import * as tf from '@tensorflow/tfjs-node';
import {
  ensureDataFiles,
  gunzipBuffer,
  parseImages,
  parseLabels,
  oneHot,
  FILES,
  CACHE_DIR,
} from './emnist-data.js';

export interface TrainConfig {
  targetLetters: readonly string[];
  targetEmnistIndices: number[];
  numClasses: number;
}

/**
 * Filter images+labels to only target classes, remap labels to 0..numClasses-1.
 */
function filterAndRemap(
  images: Float32Array,
  labels: Uint8Array,
  emnistToModel: Int8Array
): { images: Float32Array; labels: Uint8Array; count: number } {
  const total = labels.length;

  let count = 0;
  for (let i = 0; i < total; i++) {
    if (emnistToModel[labels[i]] >= 0) count++;
  }

  const filteredImages = new Float32Array(count * 784);
  const filteredLabels = new Uint8Array(count);
  let idx = 0;

  for (let i = 0; i < total; i++) {
    const modelIdx = emnistToModel[labels[i]];
    if (modelIdx >= 0) {
      filteredImages.set(images.subarray(i * 784, (i + 1) * 784), idx * 784);
      filteredLabels[idx] = modelIdx;
      idx++;
    }
  }

  return { images: filteredImages, labels: filteredLabels, count };
}

/**
 * Data augmentation: Gaussian noise + random translation (±3px)
 */
function augment(images: tf.Tensor4D): tf.Tensor4D {
  return tf.tidy(() => {
    const [n, h, w, c] = images.shape;
    const pad = 3;

    const padded = images.pad([
      [0, 0],
      [pad, pad],
      [pad, pad],
      [0, 0],
    ]) as tf.Tensor4D;

    const paddedH = h + 2 * pad;
    const paddedW = w + 2 * pad;

    const offsetY = tf.randomUniform([n], 0, 2 * pad + 1, 'int32');
    const offsetX = tf.randomUniform([n], 0, 2 * pad + 1, 'int32');

    const offsetYArr = offsetY.dataSync();
    const offsetXArr = offsetX.dataSync();

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

    const noise = tf.randomNormal([n, h, w, c], 0, 0.04);
    const noisy = cropped.add(noise).clipByValue(0, 1) as tf.Tensor4D;

    offsetY.dispose();
    offsetX.dispose();

    return noisy;
  });
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
  testCount: number,
  config: TrainConfig
) {
  const { targetLetters, targetEmnistIndices, numClasses } = config;
  const result = model.evaluate(testXs, testYs) as tf.Tensor[];
  const testAcc = (await result[1].data())[0];
  console.log(`\nFinal test accuracy: ${(testAcc * 100).toFixed(2)}%`);

  console.log('\nPer-class accuracy:');
  const predictions = model.predict(testXs) as tf.Tensor;
  const predIndices = predictions.argMax(-1).dataSync();
  const trueIndices = testYs.argMax(-1).dataSync();

  const classCorrect = new Int32Array(numClasses);
  const classTotal = new Int32Array(numClasses);
  const confusionCounts: Record<string, number> = {};

  for (let i = 0; i < testCount; i++) {
    const trueClass = trueIndices[i];
    const predClass = predIndices[i];
    classTotal[trueClass]++;
    if (predClass === trueClass) {
      classCorrect[trueClass]++;
    } else {
      const key = `${targetLetters[trueClass]}→${targetLetters[predClass]}`;
      confusionCounts[key] = (confusionCounts[key] || 0) + 1;
    }
  }

  for (let i = 0; i < numClasses; i++) {
    const acc = classTotal[i] > 0 ? ((classCorrect[i] / classTotal[i]) * 100).toFixed(1) : 'N/A';
    console.log(`  ${targetLetters[i]}: ${acc}% (${classCorrect[i]}/${classTotal[i]})`);
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

  const modelConfig = {
    numClasses,
    letters: [...targetLetters],
    alphabetIndices: targetEmnistIndices,
  };
  await writeFile(path.join(modelDir, 'config.json'), JSON.stringify(modelConfig, null, 2) + '\n');
  console.log(`Config saved to ${modelDir}/config.json`);

  predictions.dispose();
  for (const t of result) t.dispose();
}

export async function runTraining(config: TrainConfig): Promise<void> {
  const { targetLetters, targetEmnistIndices, numClasses } = config;

  console.log(`=== Training ${numClasses}-class EMNIST model for T3 ===`);
  console.log(`Target letters: ${targetLetters.join(', ')}\n`);

  const emnistToModel = new Int8Array(26).fill(-1);
  for (let i = 0; i < targetEmnistIndices.length; i++) {
    emnistToModel[targetEmnistIndices[i]] = i;
  }

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

  console.log(`\nFiltering to ${numClasses} target classes...`);
  const train = filterAndRemap(trainImages, trainLabels, emnistToModel);
  const test = filterAndRemap(testImages, testLabels, emnistToModel);
  console.log(`  Train: ${train.count} (from ${trainLabels.length})`);
  console.log(`  Test: ${test.count} (from ${testLabels.length})`);

  const trainCounts = new Int32Array(numClasses);
  for (let i = 0; i < train.count; i++) trainCounts[train.labels[i]]++;
  console.log('\n  Per-class training samples:');
  for (let i = 0; i < numClasses; i++) {
    console.log(`    ${targetLetters[i]}: ${trainCounts[i]}`);
  }

  const trainXs = tf.tensor4d(train.images, [train.count, 28, 28, 1]);
  const trainYs = tf.tensor2d(oneHot(train.labels, numClasses), [train.count, numClasses]);
  const testXs = tf.tensor4d(test.images, [test.count, 28, 28, 1]);
  const testYs = tf.tensor2d(oneHot(test.labels, numClasses), [test.count, numClasses]);

  console.log(`\nBuilding model (${numClasses}-class CNN)...`);
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
  model.add(tf.layers.dense({ units: numClasses, activation: 'softmax' }));

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
  await evaluateAndSave(model, testXs, testYs, test.count, config);

  trainXs.dispose();
  trainYs.dispose();
  testXs.dispose();
  testYs.dispose();
}
