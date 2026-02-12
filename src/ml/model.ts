import * as tf from '@tensorflow/tfjs';

let cachedModel: tf.LayersModel | null = null;

export async function loadModel(onProgress?: (msg: string) => void): Promise<tf.LayersModel> {
  if (cachedModel) return cachedModel;

  onProgress?.('Loading pre-trained model...');
  cachedModel = await tf.loadLayersModel('/model/model.json');
  onProgress?.('Model ready!');
  return cachedModel;
}

function preprocessCanvas(canvas: HTMLCanvasElement): tf.Tensor4D {
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  // Find bounding box of drawn content (white pixels on black bg)
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

  // Nothing drawn yet — return blank
  if (minX > maxX || minY > maxY) {
    return tf.zeros([1, 28, 28, 1]) as tf.Tensor4D;
  }

  // Add padding around the digit
  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  // Make square, centered on content
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const size = Math.max(boxW, boxH, 40); // min 40px to avoid tiny crops
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Render into 28x28 canvas (digit in 20x20 center area, like MNIST)
  const outCanvas = document.createElement('canvas');
  outCanvas.width = 28;
  outCanvas.height = 28;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.fillStyle = 'black';
  outCtx.fillRect(0, 0, 28, 28);
  outCtx.drawImage(canvas, cx - size / 2, cy - size / 2, size, size, 2, 2, 24, 24);

  const outData = outCtx.getImageData(0, 0, 28, 28);
  const tensor = tf.browser.fromPixels(outData, 1);
  return tensor.toFloat().div(255.0).reshape([1, 28, 28, 1]) as tf.Tensor4D;
}

export function predict(
  model: tf.LayersModel,
  canvas: HTMLCanvasElement
): { digit: number; confidence: number; allConfidences: number[] } {
  const input = preprocessCanvas(canvas);
  const prediction = model.predict(input) as tf.Tensor;
  const allConfidences = Array.from(prediction.dataSync());

  input.dispose();
  prediction.dispose();

  const digit = allConfidences.indexOf(Math.max(...allConfidences));
  const confidence = allConfidences[digit];

  return { digit, confidence, allConfidences };
}

/** Extract the preprocessed 28x28 grayscale image as a flat 784-element array */
export function getImageData28x28(canvas: HTMLCanvasElement): number[] {
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

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
  if (minX > maxX) return new Array(784).fill(0);

  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const size = Math.max(boxW, boxH, 40);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = 28;
  outCanvas.height = 28;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.fillStyle = 'black';
  outCtx.fillRect(0, 0, 28, 28);
  outCtx.drawImage(canvas, cx - size / 2, cy - size / 2, size, size, 2, 2, 24, 24);

  const outData = outCtx.getImageData(0, 0, 28, 28);
  const result: number[] = [];
  for (let i = 0; i < 784; i++) {
    result.push(outData.data[i * 4] / 255);
  }
  return result;
}
