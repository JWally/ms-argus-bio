import { runTraining } from './train-emnist-impl.js';

// 15-class model: original letter set (excludes letters with number lookalikes)
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

runTraining({
  targetLetters: TARGET_LETTERS,
  targetEmnistIndices: TARGET_EMNIST_INDICES,
  numClasses: 15,
}).catch(console.error);
