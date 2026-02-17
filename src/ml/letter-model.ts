import * as tf from '@tensorflow/tfjs';
import { renderTo28x28 } from './preprocess';

let cachedModel: tf.LayersModel | null = null;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function loadLetterModel(onProgress?: (msg: string) => void): Promise<tf.LayersModel> {
  if (cachedModel) return cachedModel;

  onProgress?.('Loading letter recognition model...');
  cachedModel = await tf.loadLayersModel('/model-emnist/model.json');
  onProgress?.('Letter model ready!');
  return cachedModel;
}

export interface LetterPrediction {
  letter: string;
  confidence: number;
  allConfidences: number[];
}

/**
 * Predict the letter drawn in a specific cell region of the canvas.
 */
export function predictLetter(
  model: tf.LayersModel,
  canvas: HTMLCanvasElement,
  cellRect: { x: number; y: number; w: number; h: number }
): LetterPrediction {
  const region = { sx: cellRect.x, sy: cellRect.y, sw: cellRect.w, sh: cellRect.h };
  const { outCanvas, empty } = renderTo28x28(canvas, region, 15);

  let input: tf.Tensor4D;
  if (empty) {
    input = tf.zeros([1, 28, 28, 1]) as tf.Tensor4D;
  } else {
    const outData = outCanvas.getContext('2d')!.getImageData(0, 0, 28, 28);
    input = tf.tidy(() => {
      const tensor = tf.browser.fromPixels(outData, 1);
      return tensor.toFloat().div(255.0).reshape([1, 28, 28, 1]) as tf.Tensor4D;
    });
  }

  const prediction = model.predict(input) as tf.Tensor;
  const allConfidences = Array.from(prediction.dataSync());

  input.dispose();
  prediction.dispose();

  const maxIdx = allConfidences.indexOf(Math.max(...allConfidences));
  return { letter: LETTERS[maxIdx], confidence: allConfidences[maxIdx], allConfidences };
}
