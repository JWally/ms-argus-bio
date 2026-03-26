import { mkdir, readFile } from 'fs/promises';
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

const NUM_CLASSES = 26; // A-Z

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
