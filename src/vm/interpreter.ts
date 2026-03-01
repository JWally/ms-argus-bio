/** Mini VM interpreter — sync + async dispatch loops */

import { decodeInstruction } from './format';
import { Op, hasOperand } from './opcodes';
import type { BytecodeModule } from './module';
import { MiniVM, VMStatus, isFuncObj } from './vm';
import type { CallFrame, FuncObj } from './vm';
import type { ApiBridge } from './bridge';

const MAX_INSTRUCTIONS = 50_000;

export interface ExecutionResult {
  value: unknown;
  instructionsExecuted: number;
}

export function execute(
  module: BytecodeModule,
  bridge?: ApiBridge,
  args?: unknown[]
): ExecutionResult {
  const vm = new MiniVM(module);
  if (bridge) vm.bridge = bridge;

  if (args) {
    for (let i = 0; i < args.length && i < 7; i++) {
      vm.registers[i + 1] = args[i];
    }
  }

  vm.status = VMStatus.RUNNING;
  return run(vm);
}

/** Execute a bytecode module, supporting async operations */
export async function executeAsync(
  module: BytecodeModule,
  bridge?: ApiBridge,
  args?: unknown[]
): Promise<ExecutionResult> {
  const vm = new MiniVM(module);
  if (bridge) vm.bridge = bridge;

  if (args) {
    for (let i = 0; i < args.length && i < 7; i++) {
      vm.registers[i + 1] = args[i];
    }
  }

  vm.status = VMStatus.RUNNING;
  return runAsync(vm);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;

function run(vm: MiniVM): ExecutionResult {
  const { registers: reg, module } = vm;
  const { code, strings, numbers, apiTable } = module;
  let ic = 0;

  while (vm.status === VMStatus.RUNNING && vm.pc < code.length) {
    if (++ic > MAX_INSTRUCTIONS) throw new Error('Execution limit exceeded');

    const word = code[vm.pc];
    const { opcode, dst, src1, src2 } = decodeInstruction(word);

    let operand = 0;
    if (hasOperand(opcode)) {
      operand = code[vm.pc + 1];
    }

    dispatch(vm, opcode, dst, src1, src2, operand, reg, strings, numbers, apiTable);
  }

  if (vm.pc >= code.length && vm.status === VMStatus.RUNNING) {
    vm.status = VMStatus.HALTED;
  }

  return { value: reg[0], instructionsExecuted: ic };
}

async function runAsync(vm: MiniVM): Promise<ExecutionResult> {
  const { registers: reg, module } = vm;
  const { code, strings, numbers, apiTable } = module;
  let ic = 0;

  while (vm.status === VMStatus.RUNNING && vm.pc < code.length) {
    if (++ic > MAX_INSTRUCTIONS) throw new Error('Execution limit exceeded');

    const word = code[vm.pc];
    const { opcode, dst, src1, src2 } = decodeInstruction(word);

    let operand = 0;
    if (hasOperand(opcode)) {
      operand = code[vm.pc + 1];
    }

    if (opcode === Op.API_CALL_ASYNC) {
      await dispatchAsync(vm, opcode, dst, src1, src2, operand, reg, apiTable);
    } else {
      dispatch(vm, opcode, dst, src1, src2, operand, reg, strings, numbers, apiTable);
    }
  }

  if (vm.pc >= code.length && vm.status === VMStatus.RUNNING) {
    vm.status = VMStatus.HALTED;
  }

  return { value: reg[0], instructionsExecuted: ic };
}

// eslint-disable-next-line max-params -- VM hot path, object wrapper adds overhead
function dispatch(
  vm: MiniVM,
  opcode: number,
  dst: number,
  src1: number,
  src2: number,
  operand: number,
  reg: unknown[],
  strings: string[],
  numbers: number[],
  apiTable: { apiId: number; nameIdx: number }[]
): void {
  switch (opcode) {
    // === Data movement ===
    case Op.MOV:
      reg[dst] = reg[src1];
      vm.pc += 1;
      break;
    case Op.LOAD_CONST_STR:
      reg[dst] = strings[operand];
      vm.pc += 2;
      break;
    case Op.LOAD_CONST_NUM:
      reg[dst] = numbers[operand];
      vm.pc += 2;
      break;
    case Op.LOAD_BOOL:
      reg[dst] = src1 !== 0;
      vm.pc += 1;
      break;
    case Op.LOAD_NULL:
      reg[dst] = null;
      vm.pc += 1;
      break;
    case Op.LOAD_UNDEF:
      reg[dst] = undefined;
      vm.pc += 1;
      break;
    case Op.LOAD_INT:
      reg[dst] = operand | 0;
      vm.pc += 2;
      break;

    // === Property access ===
    case Op.GET_PROP:
      reg[dst] = (reg[src1] as R)[reg[src2] as R];
      vm.pc += 1;
      break;
    case Op.GET_PROP_STR:
      reg[dst] = (reg[src1] as R)[strings[operand]];
      vm.pc += 2;
      break;
    case Op.SET_PROP_STR:
      (reg[dst] as R)[strings[operand]] = reg[src1];
      vm.pc += 2;
      break;
    case Op.TYPEOF:
      reg[dst] = typeof reg[src1];
      vm.pc += 1;
      break;

    // === API bridge ===
    case Op.API_GET: {
      const entry = apiTable[operand];
      reg[dst] = vm.bridge!.get(entry.apiId);
      vm.pc += 2;
      break;
    }
    case Op.API_CALL: {
      const entry = apiTable[operand];
      const argc = src2;
      const args: unknown[] = [];
      for (let i = 0; i < argc; i++) {
        args.push(reg[1 + i]);
      }
      reg[dst] = vm.bridge!.call(entry.apiId, reg[src1], args);
      vm.pc += 2;
      break;
    }
    case Op.API_CALL_ASYNC:
      throw new Error(
        `Async opcode 0x${opcode.toString(16)} in synchronous execution. Use executeAsync().`
      );

    // === Arithmetic ===
    case Op.ADD:
      reg[dst] = (reg[src1] as R) + (reg[src2] as R);
      vm.pc += 1;
      break;
    case Op.SUB:
      reg[dst] = (reg[src1] as number) - (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.MUL:
      reg[dst] = (reg[src1] as number) * (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.DIV:
      reg[dst] = (reg[src1] as number) / (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.MOD:
      reg[dst] = (reg[src1] as number) % (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.NEG:
      reg[dst] = -(reg[src1] as number);
      vm.pc += 1;
      break;
    case Op.BIT_XOR:
      reg[dst] = (reg[src1] as number) ^ (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.INC:
      reg[dst] = (reg[src1] as number) + 1;
      vm.pc += 1;
      break;
    case Op.ABS:
      reg[dst] = Math.abs(reg[src1] as number);
      vm.pc += 1;
      break;

    // === Comparison ===
    case Op.EQ:
      reg[dst] = reg[src1] === (reg[src2] as R);
      vm.pc += 1;
      break;
    case Op.NEQ:
      reg[dst] = reg[src1] !== (reg[src2] as R);
      vm.pc += 1;
      break;
    case Op.LT:
      reg[dst] = (reg[src1] as number) < (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.LTE:
      reg[dst] = (reg[src1] as number) <= (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.GT:
      reg[dst] = (reg[src1] as number) > (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.GTE:
      reg[dst] = (reg[src1] as number) >= (reg[src2] as number);
      vm.pc += 1;
      break;
    case Op.NOT:
      reg[dst] = !reg[src1];
      vm.pc += 1;
      break;
    case Op.AND:
      reg[dst] = reg[src1] && reg[src2];
      vm.pc += 1;
      break;
    case Op.OR:
      reg[dst] = reg[src1] || reg[src2];
      vm.pc += 1;
      break;

    // === Control flow ===
    case Op.JMP:
      vm.pc = operand;
      break;
    case Op.JMP_TRUE:
      if (reg[src1]) {
        vm.pc = operand;
      } else {
        vm.pc += 2;
      }
      break;
    case Op.JMP_FALSE:
      if (!reg[src1]) {
        vm.pc = operand;
      } else {
        vm.pc += 2;
      }
      break;
    case Op.CALL: {
      const frame: CallFrame = {
        returnPC: vm.pc + 2,
        returnReg: dst,
        savedRegisters: reg.slice(8),
        callerFunc: vm.currentFunc,
      };
      vm.callStack.push(frame);
      vm.currentFunc = null;
      vm.pc = operand;
      break;
    }
    case Op.RET: {
      const retVal = reg[src1];
      if (vm.callStack.length === 0) {
        reg[0] = retVal;
        vm.status = VMStatus.HALTED;
        return;
      }
      const frame = vm.callStack.pop()!;
      for (let i = 0; i < frame.savedRegisters.length; i++) {
        reg[8 + i] = frame.savedRegisters[i];
      }
      reg[frame.returnReg] = retVal;
      vm.currentFunc = frame.callerFunc;
      vm.pc = frame.returnPC;
      break;
    }
    case Op.HALT:
      vm.status = VMStatus.HALTED;
      break;

    // === Object/Array ===
    case Op.OBJ_NEW:
      reg[dst] = {};
      vm.pc += 1;
      break;
    case Op.ARR_NEW:
      reg[dst] = [];
      vm.pc += 1;
      break;
    case Op.ARR_PUSH:
      (reg[dst] as R[]).push(reg[src1]);
      vm.pc += 1;
      break;
    case Op.ARR_GET:
      reg[dst] = (reg[src1] as R[])[reg[src2] as number];
      vm.pc += 1;
      break;
    case Op.ARR_LEN:
      reg[dst] = (reg[src1] as R[]).length;
      vm.pc += 1;
      break;

    // === String ===
    case Op.STR_CONCAT:
      reg[dst] = String(reg[src1]) + String(reg[src2]);
      vm.pc += 1;
      break;
    case Op.STR_INCLUDES:
      reg[dst] = (reg[src1] as string).includes(reg[src2] as string);
      vm.pc += 1;
      break;
    case Op.TO_STRING:
      reg[dst] = String(reg[src1]);
      vm.pc += 1;
      break;

    // === Utility ===
    case Op.TO_NUM:
      reg[dst] = Number(reg[src1]);
      vm.pc += 1;
      break;
    case Op.MATH_FN: {
      const fnName = strings[operand];
      const fn = (Math as R)[fnName];
      if (reg[src2] !== undefined && reg[src2] !== 0 && src2 !== 0) {
        reg[dst] = fn(reg[src1], reg[src2]);
      } else {
        reg[dst] = fn(reg[src1]);
      }
      vm.pc += 2;
      break;
    }

    // === Function/Closure ===
    case Op.MAKE_FUNC: {
      const funcObj: FuncObj = { __abmv: true, pc: operand, arity: src1, upvalues: [] };
      reg[dst] = funcObj;
      vm.pc += 2;
      break;
    }
    case Op.CALL_FUNC: {
      const funcVal = reg[src1];
      if (!isFuncObj(funcVal)) throw new Error('Attempted to call non-function');
      const frame: CallFrame = {
        returnPC: vm.pc + 1,
        returnReg: dst,
        savedRegisters: reg.slice(8),
        callerFunc: vm.currentFunc,
      };
      vm.callStack.push(frame);
      vm.currentFunc = funcVal;
      vm.pc = funcVal.pc;
      break;
    }
    case Op.LOAD_UPVAL:
      if (!vm.currentFunc) throw new Error('LOAD_UPVAL outside function');
      reg[dst] = vm.currentFunc.upvalues[src1];
      vm.pc += 1;
      break;
    case Op.STORE_UPVAL:
      if (!vm.currentFunc) throw new Error('STORE_UPVAL outside function');
      vm.currentFunc.upvalues[dst] = reg[src1];
      vm.pc += 1;
      break;
    case Op.CAPTURE: {
      const funcObj = reg[dst] as FuncObj;
      funcObj.upvalues.push(reg[src1]);
      vm.pc += 1;
      break;
    }

    default:
      throw new Error(`Unknown opcode: 0x${opcode.toString(16)} at PC=${vm.pc}`);
  }
}

// eslint-disable-next-line max-params -- mirrors dispatch() signature for consistency
async function dispatchAsync(
  vm: MiniVM,
  opcode: number,
  dst: number,
  src1: number,
  src2: number,
  operand: number,
  reg: unknown[],
  apiTable: { apiId: number; nameIdx: number }[]
): Promise<void> {
  switch (opcode) {
    case Op.API_CALL_ASYNC: {
      const entry = apiTable[operand];
      const argc = src2;
      const args: unknown[] = [];
      for (let i = 0; i < argc; i++) {
        args.push(reg[1 + i]);
      }
      reg[dst] = await vm.bridge!.call(entry.apiId, reg[src1], args);
      vm.pc += 2;
      break;
    }
    default:
      throw new Error(`Unhandled async opcode: 0x${opcode.toString(16)}`);
  }
}
