/** Mini VM state — simplified register-based VM for tripwire */

import { REG_COUNT } from './format';
import type { BytecodeModule } from './module';
import type { ApiBridge } from './bridge';

export interface FuncObj {
  __abmv: true;
  pc: number;
  arity: number;
  upvalues: unknown[];
}

export function isFuncObj(val: unknown): val is FuncObj {
  return (
    val !== null && typeof val === 'object' && (val as Record<string, unknown>).__abmv === true
  );
}

export interface CallFrame {
  returnPC: number;
  returnReg: number;
  savedRegisters: unknown[];
  callerFunc: FuncObj | null;
}

export const VMStatus = {
  READY: 0,
  RUNNING: 1,
  HALTED: 3,
  ERROR: 4,
} as const;

// eslint-disable-next-line no-redeclare -- intentional TS const+type pattern
export type VMStatus = (typeof VMStatus)[keyof typeof VMStatus];

export class MiniVM {
  readonly registers: unknown[] = new Array<unknown>(REG_COUNT).fill(null);
  pc = 0;
  readonly callStack: CallFrame[] = [];
  status: VMStatus = VMStatus.READY;
  module: BytecodeModule;
  bridge: ApiBridge | null = null;
  currentFunc: FuncObj | null = null;

  constructor(module: BytecodeModule) {
    this.module = module;
  }
}
