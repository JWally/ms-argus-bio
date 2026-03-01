/** Mini VM bytecode format constants */

export const MAGIC = 0x41424d56; // "ABMV" — Argus Bio Mini VM
export const VERSION = 1;

/**
 * Instruction encoding:
 * Word 0: [opcode:8][flags:4][dst:6][src1:6][src2:8]
 */
export function encodeInstruction(
  opcode: number,
  flags: number,
  dst: number,
  src1: number,
  src2: number
): number {
  return (
    ((opcode & 0xff) << 24) |
    ((flags & 0xf) << 20) |
    ((dst & 0x3f) << 14) |
    ((src1 & 0x3f) << 8) |
    (src2 & 0xff)
  );
}

export function decodeInstruction(word: number): {
  opcode: number;
  dst: number;
  src1: number;
  src2: number;
} {
  return {
    opcode: (word >>> 24) & 0xff,
    dst: (word >>> 14) & 0x3f,
    src1: (word >>> 8) & 0x3f,
    src2: word & 0xff,
  };
}

export const REG_COUNT = 64;
