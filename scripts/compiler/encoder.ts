/** Encode a BytecodeModule into an ArrayBuffer */

import { MAGIC, VERSION } from '../../src/vm/format';
import type { BytecodeModule } from '../../src/vm/module';

export function encode(mod: BytecodeModule): ArrayBuffer {
  let size = 0;

  // Header: magic(4) + version(2) + flags(2) = 8
  size += 8;

  // Strings: count(4) + for each: length(2) + utf8 bytes
  size += 4;
  const encodedStrings: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const str of mod.strings) {
    const bytes = encoder.encode(str);
    encodedStrings.push(bytes);
    size += 2 + bytes.length;
  }

  // Numbers: count(4) + f64 per number(8 each)
  size += 4 + mod.numbers.length * 8;

  // API table: count(4) + (apiId(2) + nameIdx(2)) per entry
  size += 4 + mod.apiTable.length * 4;

  // Code: length(4) + u32 per instruction
  size += 4 + mod.code.length * 4;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;

  // Header
  view.setUint32(offset, MAGIC);
  offset += 4;
  view.setUint16(offset, VERSION);
  offset += 2;
  view.setUint16(offset, mod.flags);
  offset += 2;

  // Strings
  view.setUint32(offset, mod.strings.length);
  offset += 4;
  for (const bytes of encodedStrings) {
    view.setUint16(offset, bytes.length);
    offset += 2;
    new Uint8Array(buffer, offset, bytes.length).set(bytes);
    offset += bytes.length;
  }

  // Numbers
  view.setUint32(offset, mod.numbers.length);
  offset += 4;
  for (const num of mod.numbers) {
    view.setFloat64(offset, num);
    offset += 8;
  }

  // API table
  view.setUint32(offset, mod.apiTable.length);
  offset += 4;
  for (const entry of mod.apiTable) {
    view.setUint16(offset, entry.apiId);
    offset += 2;
    view.setUint16(offset, entry.nameIdx);
    offset += 2;
  }

  // Code
  view.setUint32(offset, mod.code.length);
  offset += 4;
  for (let i = 0; i < mod.code.length; i++) {
    view.setUint32(offset, mod.code[i]);
    offset += 4;
  }

  return buffer;
}
