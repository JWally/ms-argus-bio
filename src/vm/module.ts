/** Bytecode module — in-memory representation of a compiled unit */

export interface ApiEntry {
  apiId: number;
  nameIdx: number;
}

export interface BytecodeModule {
  version: number;
  flags: number;
  strings: string[];
  numbers: number[];
  apiTable: ApiEntry[];
  code: Uint32Array;
}
