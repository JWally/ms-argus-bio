import { describe, it, expect } from 'vitest';
import { Op, hasOperand } from './opcodes';
import { encodeInstruction, decodeInstruction, MAGIC, REG_COUNT } from './format';
import type { BytecodeModule } from './module';
import { decode } from './decoder';
import { execute } from './interpreter';
import { ApiBridge } from './bridge';

// Helper to build a simple BytecodeModule from raw instruction words
function buildModule(
  code: number[],
  opts?: { strings?: string[]; numbers?: number[]; apiTable?: { apiId: number; nameIdx: number }[] }
): BytecodeModule {
  return {
    version: 1,
    flags: 0,
    strings: opts?.strings ?? [],
    numbers: opts?.numbers ?? [],
    apiTable: opts?.apiTable ?? [],
    code: new Uint32Array(code),
  };
}

// Helper to encode a simple instruction
function enc(opcode: number, dst = 0, src1 = 0, src2 = 0): number {
  return encodeInstruction(opcode, 0, dst, src1, src2);
}

describe('format', () => {
  it('encodes and decodes instructions correctly', () => {
    const word = encodeInstruction(Op.ADD, 0, 8, 9, 10);
    const { opcode, dst, src1, src2 } = decodeInstruction(word);
    expect(opcode).toBe(Op.ADD);
    expect(dst).toBe(8);
    expect(src1).toBe(9);
    expect(src2).toBe(10);
  });

  it('handles all register ranges (0-63)', () => {
    const word = encodeInstruction(Op.MOV, 0, 63, 63, 255);
    const { dst, src1, src2 } = decodeInstruction(word);
    expect(dst).toBe(63);
    expect(src1).toBe(63);
    expect(src2).toBe(255);
  });

  it('REG_COUNT is 64', () => {
    expect(REG_COUNT).toBe(64);
  });
});

describe('opcodes', () => {
  it('hasOperand returns true for instruction with operands', () => {
    expect(hasOperand(Op.LOAD_CONST_STR)).toBe(true);
    expect(hasOperand(Op.LOAD_INT)).toBe(true);
    expect(hasOperand(Op.JMP)).toBe(true);
    expect(hasOperand(Op.API_GET)).toBe(true);
    expect(hasOperand(Op.MAKE_FUNC)).toBe(true);
  });

  it('hasOperand returns false for simple instructions', () => {
    expect(hasOperand(Op.MOV)).toBe(false);
    expect(hasOperand(Op.ADD)).toBe(false);
    expect(hasOperand(Op.HALT)).toBe(false);
    expect(hasOperand(Op.ARR_NEW)).toBe(false);
  });
});

describe('decoder', () => {
  it('decodes a binary bytecode module', () => {
    // Build binary manually
    const te = new TextEncoder();
    const helloBytes = te.encode('hello');

    // Calculate size
    const size = 8 + 4 + (2 + helloBytes.length) + 4 + 4 + 4 + (enc(Op.HALT) ? 4 : 0) + 4;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    let off = 0;

    // Header
    view.setUint32(off, MAGIC);
    off += 4;
    view.setUint16(off, 1);
    off += 2;
    view.setUint16(off, 0);
    off += 2;

    // Strings (1 string)
    view.setUint32(off, 1);
    off += 4;
    view.setUint16(off, helloBytes.length);
    off += 2;
    new Uint8Array(buf, off, helloBytes.length).set(helloBytes);
    off += helloBytes.length;

    // Numbers (0)
    view.setUint32(off, 0);
    off += 4;

    // API table (0)
    view.setUint32(off, 0);
    off += 4;

    // Code (1 instruction: HALT)
    view.setUint32(off, 1);
    off += 4;
    view.setUint32(off, enc(Op.HALT));
    off += 4;

    const mod = decode(buf);
    expect(mod.version).toBe(1);
    expect(mod.strings).toEqual(['hello']);
    expect(mod.numbers).toEqual([]);
    expect(mod.apiTable).toEqual([]);
    expect(mod.code.length).toBe(1);
  });

  it('throws on bad magic number', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0xdeadbeef);
    expect(() => decode(buf)).toThrow('Invalid bytecode');
  });
});

describe('interpreter - arithmetic', () => {
  it('adds two numbers', () => {
    // R8 = 10, R9 = 20, R10 = R8 + R9, R0 = R10, HALT
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      10,
      enc(Op.LOAD_INT, 9),
      20,
      enc(Op.ADD, 10, 8, 9),
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    const result = execute(mod);
    expect(result.value).toBe(30);
  });

  it('subtracts, multiplies, divides', () => {
    // R8 = 100, R9 = 3
    // R10 = R8 - R9 = 97
    // R11 = R8 * R9 = 300
    // R12 = R8 / R9 = 33.333...
    // R0 = R10
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      100,
      enc(Op.LOAD_INT, 9),
      3,
      enc(Op.SUB, 10, 8, 9),
      enc(Op.MUL, 11, 8, 9),
      enc(Op.DIV, 12, 8, 9),
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    const result = execute(mod);
    expect(result.value).toBe(97);
  });

  it('handles modulo and negation', () => {
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      17,
      enc(Op.LOAD_INT, 9),
      5,
      enc(Op.MOD, 10, 8, 9), // 17 % 5 = 2
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(2);
  });

  it('increments', () => {
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      41,
      enc(Op.INC, 8, 8),
      enc(Op.MOV, 0, 8),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(42);
  });
});

describe('interpreter - comparison', () => {
  it('EQ and NEQ', () => {
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      5,
      enc(Op.LOAD_INT, 9),
      5,
      enc(Op.EQ, 10, 8, 9),
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(true);
  });

  it('LT, GT, NOT', () => {
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      3,
      enc(Op.LOAD_INT, 9),
      7,
      enc(Op.LT, 10, 8, 9), // 3 < 7 = true
      enc(Op.GT, 11, 8, 9), // 3 > 7 = false
      enc(Op.NOT, 12, 11), // !false = true
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(true);
  });
});

describe('interpreter - control flow', () => {
  it('handles conditional jump (if-else)', () => {
    // if (true) { R0 = 1 } else { R0 = 2 }
    const mod2 = buildModule([
      enc(Op.LOAD_BOOL, 8, 1), // PC0
      enc(Op.JMP_FALSE, 0, 8),
      7, // PC1-2: goto PC7 if false
      enc(Op.LOAD_INT, 0),
      1, // PC3-4: R0 = 1
      enc(Op.JMP, 0),
      9, // PC5-6: goto PC9 (HALT)
      enc(Op.LOAD_INT, 0),
      2, // PC7-8: R0 = 2
      enc(Op.HALT), // PC9
    ]);
    expect(execute(mod2).value).toBe(1);
  });

  it('handles loop (while)', () => {
    // sum = 0; i = 0; while (i < 5) { sum = sum + i; i++ }
    // R8 = sum, R9 = i, R10 = 5
    const mod = buildModule([
      enc(Op.LOAD_INT, 8),
      0, // PC0-1: sum = 0
      enc(Op.LOAD_INT, 9),
      0, // PC2-3: i = 0
      enc(Op.LOAD_INT, 10),
      5, // PC4-5: limit = 5
      // loop start at PC6:
      enc(Op.LT, 11, 9, 10), // PC6: R11 = (i < 5)
      enc(Op.JMP_FALSE, 0, 11),
      13, // PC7-8: if !(i < 5) goto PC13
      enc(Op.ADD, 8, 8, 9), // PC9: sum += i
      enc(Op.INC, 9, 9), // PC10: i++
      enc(Op.JMP, 0),
      6, // PC11-12: goto PC6
      enc(Op.MOV, 0, 8), // PC13: R0 = sum
      enc(Op.HALT), // PC14
    ]);
    expect(execute(mod).value).toBe(10); // 0+1+2+3+4 = 10
  });
});

describe('interpreter - strings', () => {
  it('loads and concatenates strings', () => {
    const mod = buildModule(
      [
        enc(Op.LOAD_CONST_STR, 8),
        0, // R8 = "hello"
        enc(Op.LOAD_CONST_STR, 9),
        1, // R9 = " world"
        enc(Op.STR_CONCAT, 10, 8, 9), // R10 = "hello world"
        enc(Op.MOV, 0, 10),
        enc(Op.HALT),
      ],
      { strings: ['hello', ' world'] }
    );
    expect(execute(mod).value).toBe('hello world');
  });

  it('checks string includes', () => {
    const mod = buildModule(
      [
        enc(Op.LOAD_CONST_STR, 8),
        0, // "native code"
        enc(Op.LOAD_CONST_STR, 9),
        1, // "native"
        enc(Op.STR_INCLUDES, 10, 8, 9),
        enc(Op.MOV, 0, 10),
        enc(Op.HALT),
      ],
      { strings: ['native code', 'native'] }
    );
    expect(execute(mod).value).toBe(true);
  });
});

describe('interpreter - objects and arrays', () => {
  it('creates objects and sets properties', () => {
    const mod = buildModule(
      [
        enc(Op.OBJ_NEW, 8), // R8 = {}
        enc(Op.LOAD_INT, 9),
        42, // R9 = 42
        enc(Op.SET_PROP_STR, 8, 9),
        0, // R8["answer"] = R9
        enc(Op.GET_PROP_STR, 10, 8),
        0, // R10 = R8["answer"]
        enc(Op.MOV, 0, 10),
        enc(Op.HALT),
      ],
      { strings: ['answer'] }
    );
    expect(execute(mod).value).toBe(42);
  });

  it('creates arrays, pushes, gets length', () => {
    const mod = buildModule([
      enc(Op.ARR_NEW, 8), // R8 = []
      enc(Op.LOAD_INT, 9),
      10, // R9 = 10
      enc(Op.ARR_PUSH, 8, 9), // R8.push(10)
      enc(Op.LOAD_INT, 9),
      20, // R9 = 20
      enc(Op.ARR_PUSH, 8, 9), // R8.push(20)
      enc(Op.ARR_LEN, 10, 8), // R10 = R8.length
      enc(Op.MOV, 0, 10),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(2);
  });

  it('gets array element by index', () => {
    const mod = buildModule([
      enc(Op.ARR_NEW, 8), // R8 = []
      enc(Op.LOAD_INT, 9),
      100,
      enc(Op.ARR_PUSH, 8, 9), // [100]
      enc(Op.LOAD_INT, 9),
      200,
      enc(Op.ARR_PUSH, 8, 9), // [100, 200]
      enc(Op.LOAD_INT, 10),
      1, // index = 1
      enc(Op.ARR_GET, 11, 8, 10), // R11 = R8[1] = 200
      enc(Op.MOV, 0, 11),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(200);
  });
});

describe('interpreter - bridge calls', () => {
  it('calls API_GET via bridge', () => {
    const bridge = new ApiBridge();
    bridge.register(0x01, {
      get: () => true,
    });

    const mod = buildModule(
      [
        enc(Op.API_GET, 8),
        0, // R8 = bridge.get(apiTable[0].apiId)
        enc(Op.MOV, 0, 8),
        enc(Op.HALT),
      ],
      { apiTable: [{ apiId: 0x01, nameIdx: 0 }], strings: ['nav.webdriver'] }
    );
    expect(execute(mod, bridge).value).toBe(true);
  });

  it('calls API_CALL via bridge', () => {
    const bridge = new ApiBridge();
    bridge.register(0x09, {
      call: () => ({ strokeCount: 5, totalPoints: 100 }),
    });

    const mod = buildModule(
      [
        enc(Op.API_CALL, 8, 0, 0),
        0, // R8 = bridge.call(apiTable[0].apiId, R0, 0 args)
        enc(Op.GET_PROP_STR, 9, 8),
        0, // R9 = R8.strokeCount
        enc(Op.MOV, 0, 9),
        enc(Op.HALT),
      ],
      {
        apiTable: [{ apiId: 0x09, nameIdx: 0 }],
        strings: ['strokeCount'],
      }
    );
    expect(execute(mod, bridge).value).toBe(5);
  });
});

describe('interpreter - function calls', () => {
  it('handles CALL and RET', () => {
    // function at PC6: R0 = R1 + R1, RET
    // main: R1 = 21, CALL fn at PC6, R0 = result, HALT
    const mod = buildModule([
      enc(Op.LOAD_INT, 1),
      21, // PC0-1: R1 = 21
      enc(Op.CALL, 8, 0, 1),
      6, // PC2-3: call PC6, dst=R8, argc=1
      enc(Op.MOV, 0, 8), // PC4: R0 = R8 (return value)
      enc(Op.HALT), // PC5
      // function body at PC6:
      enc(Op.ADD, 0, 1, 1), // PC6: R0 = R1 + R1 = 42
      enc(Op.RET, 0, 0), // PC7: return R0
    ]);
    expect(execute(mod).value).toBe(42);
  });

  it('handles MAKE_FUNC and CALL_FUNC', () => {
    // Create a function that doubles its argument
    const mod = buildModule([
      // JMP to skip fn body
      enc(Op.JMP, 0),
      6, // PC0-1: goto PC6
      // fn body at PC2:
      enc(Op.LOAD_INT, 8),
      0, // PC2-3: placeholder (MOV arg from R1)
      enc(Op.ADD, 0, 1, 1), // PC4: R0 = R1 + R1
      enc(Op.RET, 0, 0), // PC5: return R0
      // main at PC6:
      enc(Op.MAKE_FUNC, 8, 1),
      2, // PC6-7: R8 = func(pc=2, arity=1)
      enc(Op.LOAD_INT, 1),
      21, // PC8-9: R1 = 21
      enc(Op.CALL_FUNC, 9, 8, 1), // PC10: R9 = R8(R1)
      enc(Op.MOV, 0, 9), // PC11: R0 = R9
      enc(Op.HALT), // PC12
    ]);
    expect(execute(mod).value).toBe(42);
  });
});

describe('interpreter - typeof and boolean ops', () => {
  it('typeof returns correct type strings', () => {
    const mod = buildModule(
      [
        enc(Op.LOAD_INT, 8),
        5,
        enc(Op.TYPEOF, 9, 8), // typeof 5 = "number"
        enc(Op.LOAD_CONST_STR, 10),
        0, // "number"
        enc(Op.EQ, 11, 9, 10), // true
        enc(Op.MOV, 0, 11),
        enc(Op.HALT),
      ],
      { strings: ['number'] }
    );
    expect(execute(mod).value).toBe(true);
  });

  it('AND, OR operators', () => {
    const mod = buildModule([
      enc(Op.LOAD_BOOL, 8, 1), // true
      enc(Op.LOAD_BOOL, 9, 0), // false
      enc(Op.AND, 10, 8, 9), // true && false = false
      enc(Op.OR, 11, 8, 9), // true || false = true
      enc(Op.MOV, 0, 11),
      enc(Op.HALT),
    ]);
    expect(execute(mod).value).toBe(true);
  });
});

describe('interpreter - execution limits', () => {
  it('throws on infinite loop', () => {
    // JMP to self
    const mod = buildModule([
      enc(Op.JMP, 0),
      0, // infinite loop
    ]);
    expect(() => execute(mod)).toThrow('Execution limit exceeded');
  });

  it('throws on unknown opcode', () => {
    const mod = buildModule([
      encodeInstruction(0xff, 0, 0, 0, 0), // unknown opcode
    ]);
    expect(() => execute(mod)).toThrow('Unknown opcode');
  });
});
