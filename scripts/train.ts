import * as tf from '@tensorflow/tfjs-node';
import { mkdir } from 'fs/promises';
import { createGunzip } from 'zlib';
import path from 'path';

const MNIST_BASE = 'https://storage.googleapis.com/cvdf-datasets/mnist/';
const FILES = {
  trainImages: 'train-images-idx3-ubyte.gz',
  trainLabels: 'train-labels-idx1-ubyte.gz',
  testImages: 't10k-images-idx3-ubyte.gz',
  testLabels: 't10k-labels-idx1-ubyte.gz',
};

async function fetchAndDecompress(url: string): Promise<Buffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const compressed = Buffer.from(arrayBuffer);

  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });
}

function parseImages(buffer: Buffer): Float32Array {
  const numImages = buffer.readUInt32BE(4);
  const rows = buffer.readUInt32BE(8);
  const cols = buffer.readUInt32BE(12);
  console.log(`  Images: ${numImages} x ${rows}x${cols}`);

  const pixels = new Float32Array(numImages * rows * cols);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = buffer[16 + i] / 255;
  }
  return pixels;
}

function parseLabels(buffer: Buffer): Uint8Array {
  const numLabels = buffer.readUInt32BE(4);
  console.log(`  Labels: ${numLabels}`);
  return new Uint8Array(buffer.buffer, buffer.byteOffset + 8, numLabels);
}

function oneHot(labels: Uint8Array, numClasses: number): Float32Array {
  const result = new Float32Array(labels.length * numClasses);
  for (let i = 0; i < labels.length; i++) {
    result[i * numClasses + labels[i]] = 1;
  }
  return result;
}

async function main() {
  console.log('Downloading MNIST dataset...');
  const [trainImgBuf, trainLblBuf, testImgBuf, testLblBuf] =
    await Promise.all([
      fetchAndDecompress(MNIST_BASE + FILES.trainImages),
      fetchAndDecompress(MNIST_BASE + FILES.trainLabels),
      fetchAndDecompress(MNIST_BASE + FILES.testImages),
      fetchAndDecompress(MNIST_BASE + FILES.testLabels),
    ]);

  console.log('Parsing...');
  const trainImages = parseImages(trainImgBuf);
  const trainLabels = parseLabels(trainLblBuf);
  const testImages = parseImages(testImgBuf);
  const testLabels = parseLabels(testLblBuf);

  const trainXs = tf.tensor4d(trainImages, [60000, 28, 28, 1]);
  const trainYs = tf.tensor2d(oneHot(trainLabels, 10), [60000, 10]);
  const testXs = tf.tensor4d(testImages, [10000, 28, 28, 1]);
  const testYs = tf.tensor2d(oneHot(testLabels, 10), [10000, 10]);

  console.log('\nBuilding model...');
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
  model.add(
    tf.layers.conv2d({ filters: 64, kernelSize: 3, activation: 'relu' })
  );
  model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dense({ units: 128, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.25 }));
  model.add(tf.layers.dense({ units: 10, activation: 'softmax' }));

  model.compile({
    optimizer: tf.train.adam(),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  model.summary();

  console.log('\nTraining on full 60k dataset (10 epochs)...\n');
  await model.fit(trainXs, trainYs, {
    epochs: 10,
    batchSize: 128,
    validationData: [testXs, testYs],
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        console.log(
          `  Epoch ${epoch + 1}/10 — ` +
            `loss: ${logs!.loss.toFixed(4)}, acc: ${(logs!.acc * 100).toFixed(1)}% | ` +
            `val_loss: ${logs!.val_loss.toFixed(4)}, val_acc: ${(logs!.val_acc * 100).toFixed(1)}%`
        );
      },
    },
  });

  const result = model.evaluate(testXs, testYs) as tf.Tensor[];
  const testAcc = (await result[1].data())[0];
  console.log(`\nFinal test accuracy: ${(testAcc * 100).toFixed(2)}%`);

  const modelDir = path.resolve('public/model');
  await mkdir(modelDir, { recursive: true });
  await model.save(`file://${modelDir}`);
  console.log(`Model saved to ${modelDir}/`);

  trainXs.dispose();
  trainYs.dispose();
  testXs.dispose();
  testYs.dispose();
  result.forEach((t) => t.dispose());
}

main().catch(console.error);
