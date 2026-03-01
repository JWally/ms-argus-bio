/** Decode an ArrayBuffer into a BytecodeModule */

import { MAGIC } from './format';
import type { BytecodeModule, ApiEntry } from './module';

export function decode(buffer: ArrayBuffer): BytecodeModule {
  const view = new DataView(buffer);
  let offset = 0;

  const magic = view.getUint32(offset);
  offset += 4;
  if (magic !== MAGIC) {
    throw new Error(`Invalid bytecode: bad magic 0x${magic.toString(16)}`);
  }

  const version = view.getUint16(offset);
  offset += 2;
  const flags = view.getUint16(offset);
  offset += 2;

  // Strings
  const stringCount = view.getUint32(offset);
  offset += 4;
  const td = new TextDecoder();
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const len = view.getUint16(offset);
    offset += 2;
    const bytes = new Uint8Array(buffer, offset, len);
    strings.push(td.decode(bytes));
    offset += len;
  }

  // Numbers
  const numCount = view.getUint32(offset);
  offset += 4;
  const numbers: number[] = [];
  for (let i = 0; i < numCount; i++) {
    numbers.push(view.getFloat64(offset));
    offset += 8;
  }

  // API table
  const apiCount = view.getUint32(offset);
  offset += 4;
  const apiTable: ApiEntry[] = [];
  for (let i = 0; i < apiCount; i++) {
    const apiId = view.getUint16(offset);
    offset += 2;
    const nameIdx = view.getUint16(offset);
    offset += 2;
    apiTable.push({ apiId, nameIdx });
  }

  // Code
  const codeLen = view.getUint32(offset);
  offset += 4;
  const code = new Uint32Array(codeLen);
  for (let i = 0; i < codeLen; i++) {
    code[i] = view.getUint32(offset);
    offset += 4;
  }

  return { version, flags, strings, numbers, apiTable, code };
}
