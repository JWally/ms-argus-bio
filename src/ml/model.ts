import * as tf from '@tensorflow/tfjs';
import { renderTo28x28 } from './preprocess';

let cachedModel: tf.LayersModel | null = null;

export async function loadModel(onProgress?: (msg: string) => void): Promise<tf.LayersModel> {
  if (cachedModel) return cachedModel;

  onProgress?.('Loading pre-trained model...');
  cachedModel = await tf.loadLayersModel('/model/model.json');
  onProgress?.('Model ready!');
  return cachedModel;
}

function preprocessCanvas(canvas: HTMLCanvasElement): tf.Tensor4D {
  const region = { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height };
  const { outCanvas, empty } = renderTo28x28(canvas, region, 20);
  if (empty) return tf.zeros([1, 28, 28, 1]) as tf.Tensor4D;

  const outData = outCanvas.getContext('2d')!.getImageData(0, 0, 28, 28);
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
  const region = { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height };
  const { outCanvas, empty } = renderTo28x28(canvas, region, 20);
  if (empty) return new Array(784).fill(0);

  const outData = outCanvas.getContext('2d')!.getImageData(0, 0, 28, 28);
  const result: number[] = [];
  for (let i = 0; i < 784; i++) {
    result.push(outData.data[i * 4] / 255);
  }
  return result;
}
