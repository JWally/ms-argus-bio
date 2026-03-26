import { runTraining } from './train-emnist-impl.js';

// 23-class model: expanded letter set
// Excluded: D (too similar to O), Q (too similar to O), V (too similar to U)
const TARGET_LETTERS = [
  'A',
  'B',
  'C',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'R',
  'S',
  'T',
  'U',
  'W',
  'X',
  'Y',
  'Z',
] as const;

// EMNIST labels are 1-indexed (A=1..Z=26), so 0-indexed: A=0, B=1, C=2, ...
const TARGET_EMNIST_INDICES = [
  0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 22, 23, 24, 25,
];

runTraining({
  targetLetters: TARGET_LETTERS,
  targetEmnistIndices: TARGET_EMNIST_INDICES,
  numClasses: 23,
}).catch(console.error);
