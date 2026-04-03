/** Code generator — AST → opcode emission */

import { encodeInstruction } from '../../src/vm/format';
import { Op } from '../../src/vm/opcodes';
import { RegisterAllocator } from './register-allocator';
import { ConstantPool } from './constant-pool';
import { Scope } from './scope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

interface PendingJump {
  codeIndex: number; // index in code array where the operand should be patched
  label: string;
}

export class CodeGenerator {
  readonly code: number[] = [];
  readonly pool: ConstantPool;
  alloc: RegisterAllocator;
  private scope: Scope;
  private readonly labels = new Map<string, number>();
  private readonly pendingJumps: PendingJump[] = [];
  private labelCounter = 0;

  /** API table entries added by __api_get / __api_call / __api_call_async / __api_new */
  readonly apiEntries: Array<{ apiId: number; nameIdx: number }> = [];
  private readonly apiIndexMap = new Map<number, number>(); // apiId → index in apiEntries

  constructor(pool?: ConstantPool) {
    this.pool = pool ?? new ConstantPool();
    this.alloc = new RegisterAllocator();
    this.scope = new Scope();
  }

  /** Register an API ID and return its index in the apiTable */
  private getApiIndex(apiId: number): number {
    const existing = this.apiIndexMap.get(apiId);
    if (existing !== undefined) return existing;
    const nameIdx = this.pool.addString(`api_${apiId}`);
    const index = this.apiEntries.length;
    this.apiEntries.push({ apiId, nameIdx });
    this.apiIndexMap.set(apiId, index);
    return index;
  }

  /** Free a register ONLY if it's a temp (not bound to a variable) */
  private freeTemp(reg: number): void {
    if (reg >= 8 && !this.scope.hasRegister(reg)) {
      this.alloc.free(reg);
    }
  }

  /** Generate a unique label name */
  private label(prefix: string): string {
    return `${prefix}_${this.labelCounter++}`;
  }

  /** Mark current code position as a label */
  private markLabel(name: string): void {
    this.labels.set(name, this.code.length);
  }

  /** Emit a simple instruction (no operand) */
  private emit(opcode: number, dst = 0, src1 = 0, src2 = 0): void {
    this.code.push(encodeInstruction(opcode, 0, dst, src1, src2));
  }

  /** Emit an instruction with an operand word */
  private emitOp(opcode: number, dst: number, src1: number, src2: number, operand: number): void {
    this.code.push(encodeInstruction(opcode, 0, dst, src1, src2));
    this.code.push(operand);
  }

  /** Emit a jump with a pending label resolution */
  private emitJump(opcode: number, src1: number, labelName: string): void {
    this.code.push(encodeInstruction(opcode, 0, 0, src1, 0));
    this.pendingJumps.push({ codeIndex: this.code.length, label: labelName });
    this.code.push(0); // placeholder
  }

  /** Resolve all pending jumps */
  resolveJumps(): void {
    for (const pj of this.pendingJumps) {
      const target = this.labels.get(pj.label);
      if (target === undefined) {
        throw new Error(`Undefined label: ${pj.label}`);
      }
      this.code[pj.codeIndex] = target;
    }
  }

  /** Compile a program (list of statements), returning the result in R0 */
  compileProgram(body: Node[]): void {
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      const reg = this.compileStatement(stmt);
      // Last expression's value goes to R0
      if (i === body.length - 1 && reg !== 0) {
        this.emit(Op.MOV, 0, reg);
      }
    }
    this.emit(Op.HALT);
    this.resolveJumps();
  }

  /** Compile a statement, return register with result (or 0) */
  compileStatement(node: Node): number {
    switch (node.type) {
      case 'VariableDeclaration':
        return this.compileVarDeclaration(node);
      case 'ExpressionStatement':
        return this.compileExpression(node.expression as Node);
      case 'ReturnStatement':
        return this.compileReturn(node);
      case 'IfStatement':
        return this.compileIf(node);
      case 'WhileStatement':
        return this.compileWhile(node);
      case 'ForStatement':
        return this.compileFor(node);
      case 'BlockStatement':
        return this.compileBlock(node);
      case 'TryStatement':
        return this.compileTry(node);
      case 'ThrowStatement': {
        const argReg = this.compileExpression(node.argument as Node);
        this.emit(Op.THROW, 0, argReg);
        return 0;
      }
      case 'FunctionDeclaration':
        return this.compileFunctionDecl(node);
      default:
        // Try as expression
        return this.compileExpression(node);
    }
  }

  private compileVarDeclaration(node: Node): number {
    const declarations = node.declarations as Node[];
    const kind = node.kind as string;
    let lastReg = 0;

    for (const decl of declarations) {
      const id = decl.id as Node;
      const name = (id as { name: string }).name;
      const reg = this.alloc.alloc();

      if (decl.init) {
        const initReg = this.compileExpression(decl.init as Node);
        this.emit(Op.MOV, reg, initReg);
        this.freeTemp(initReg);
      } else {
        this.emit(Op.LOAD_UNDEF, reg);
      }

      this.scope.define(name, reg, kind as 'const' | 'let' | 'var');
      lastReg = reg;
    }
    return lastReg;
  }

  private compileReturn(node: Node): number {
    if (node.argument) {
      const reg = this.compileExpression(node.argument as Node);
      this.emit(Op.RET, 0, reg);
    } else {
      this.emit(Op.LOAD_UNDEF, 0);
      this.emit(Op.RET, 0, 0);
    }
    return 0;
  }

  private compileIf(node: Node): number {
    const testReg = this.compileExpression(node.test as Node);
    const elseLabel = this.label('else');
    const endLabel = this.label('endif');

    if (node.alternate) {
      this.emitJump(Op.JMP_FALSE, testReg, elseLabel);
      this.freeTemp(testReg);
      this.compileStatement(node.consequent as Node);
      this.emitJump(Op.JMP, 0, endLabel);
      this.markLabel(elseLabel);
      this.compileStatement(node.alternate as Node);
      this.markLabel(endLabel);
    } else {
      this.emitJump(Op.JMP_FALSE, testReg, endLabel);
      this.freeTemp(testReg);
      this.compileStatement(node.consequent as Node);
      this.markLabel(endLabel);
    }
    return 0;
  }

  private compileWhile(node: Node): number {
    const loopLabel = this.label('while');
    const endLabel = this.label('endwhile');

    this.markLabel(loopLabel);
    const testReg = this.compileExpression(node.test as Node);
    this.emitJump(Op.JMP_FALSE, testReg, endLabel);
    this.freeTemp(testReg);
    this.compileStatement(node.body as Node);
    this.emitJump(Op.JMP, 0, loopLabel);
    this.markLabel(endLabel);
    return 0;
  }

  private compileFor(node: Node): number {
    const loopLabel = this.label('for');
    const endLabel = this.label('endfor');

    if (node.init) {
      if ((node.init as Node).type === 'VariableDeclaration') {
        this.compileVarDeclaration(node.init as Node);
      } else {
        this.compileExpression(node.init as Node);
      }
    }

    this.markLabel(loopLabel);
    if (node.test) {
      const testReg = this.compileExpression(node.test as Node);
      this.emitJump(Op.JMP_FALSE, testReg, endLabel);
      this.freeTemp(testReg);
    }

    this.compileStatement(node.body as Node);

    if (node.update) {
      this.compileExpression(node.update as Node);
    }

    this.emitJump(Op.JMP, 0, loopLabel);
    this.markLabel(endLabel);
    return 0;
  }

  private compileBlock(node: Node): number {
    const oldScope = this.scope;
    this.scope = this.scope.child();
    const body = node.body as Node[];
    let lastReg = 0;
    for (const stmt of body) {
      lastReg = this.compileStatement(stmt);
    }
    this.scope = oldScope;
    return lastReg;
  }

  private compileTry(node: Node): number {
    const catchLabel = this.label('catch');
    const endLabel = this.label('endtry');

    this.emitOp(Op.ENTER_TRY, 0, 0, 0, 0);
    this.pendingJumps.push({ codeIndex: this.code.length - 1, label: catchLabel });

    this.compileStatement(node.block as Node);
    this.emit(Op.LEAVE_TRY);
    this.emitJump(Op.JMP, 0, endLabel);

    this.markLabel(catchLabel);
    this.emit(Op.LEAVE_TRY);
    if (node.handler) {
      const handler = node.handler as Node;
      const param = handler.param as Node | null;
      if (param) {
        const errReg = this.alloc.alloc();
        this.emit(Op.CATCH, errReg);
        this.scope.define((param as { name: string }).name, errReg, 'let');
      } else {
        const errReg = this.alloc.alloc();
        this.emit(Op.CATCH, errReg);
        this.alloc.free(errReg);
      }
      this.compileStatement(handler.body as Node);
    }

    this.markLabel(endLabel);
    return 0;
  }

  private compileFunctionDecl(node: Node): number {
    const name = node.id?.name as string;
    if (!name) return 0;

    // Pre-define name in scope so the function body can self-reference (recursion)
    const funcReg = this.alloc.alloc();
    this.scope.define(name, funcReg, 'const');

    // Compile the function body, outputting MAKE_FUNC to funcReg
    // CAPTURE for self-reference will read funcReg AFTER MAKE_FUNC sets it
    this.compileFunctionExpr(node, funcReg);
    return funcReg;
  }

  /** Compile an expression, return register containing the result */
  compileExpression(node: Node): number {
    switch (node.type) {
      case 'Literal':
        return this.compileLiteral(node);
      case 'Identifier':
        return this.compileIdentifier(node);
      case 'BinaryExpression':
      case 'LogicalExpression':
        return this.compileBinary(node);
      case 'UnaryExpression':
        return this.compileUnary(node);
      case 'AssignmentExpression':
        return this.compileAssignment(node);
      case 'UpdateExpression':
        return this.compileUpdate(node);
      case 'MemberExpression':
        return this.compileMemberExpression(node);
      case 'CallExpression':
        return this.compileCallExpression(node);
      case 'NewExpression':
        return this.compileNewExpression(node);
      case 'ObjectExpression':
        return this.compileObjectExpression(node);
      case 'ArrayExpression':
        return this.compileArrayExpression(node);
      case 'ConditionalExpression':
        return this.compileConditional(node);
      case 'TemplateLiteral':
        return this.compileTemplateLiteral(node);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return this.compileFunctionExpr(node);
      case 'AwaitExpression':
        return this.compileAwait(node);
      default:
        throw new Error(`Unsupported expression type: ${node.type}`);
    }
  }

  private compileLiteral(node: Node): number {
    const reg = this.alloc.alloc();
    const value = node.value;

    if (typeof value === 'string') {
      const idx = this.pool.addString(value);
      this.emitOp(Op.LOAD_CONST_STR, reg, 0, 0, idx);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
        this.emitOp(Op.LOAD_INT, reg, 0, 0, value | 0);
      } else {
        const idx = this.pool.addNumber(value);
        this.emitOp(Op.LOAD_CONST_NUM, reg, 0, 0, idx);
      }
    } else if (typeof value === 'boolean') {
      this.emit(Op.LOAD_BOOL, reg, value ? 1 : 0);
    } else if (value === null) {
      this.emit(Op.LOAD_NULL, reg);
    } else if (value instanceof RegExp) {
      // Store pattern as string
      const idx = this.pool.addString(value.source);
      this.emitOp(Op.LOAD_CONST_STR, reg, 0, 0, idx);
    } else {
      this.emit(Op.LOAD_UNDEF, reg);
    }
    return reg;
  }

  private compileIdentifier(node: Node): number {
    const name = (node as { name: string }).name;

    // Special globals
    if (name === 'undefined') {
      const reg = this.alloc.alloc();
      this.emit(Op.LOAD_UNDEF, reg);
      return reg;
    }
    if (name === 'NaN') {
      const reg = this.alloc.alloc();
      const idx = this.pool.addNumber(NaN);
      this.emitOp(Op.LOAD_CONST_NUM, reg, 0, 0, idx);
      return reg;
    }
    if (name === 'Infinity') {
      const reg = this.alloc.alloc();
      const idx = this.pool.addNumber(Infinity);
      this.emitOp(Op.LOAD_CONST_NUM, reg, 0, 0, idx);
      return reg;
    }

    const variable = this.scope.lookup(name);
    if (variable) {
      return variable.register;
    }

    throw new Error(`Undefined variable: ${name}`);
  }

  private compileBinary(node: Node): number {
    const left = this.compileExpression(node.left as Node);
    const right = this.compileExpression(node.right as Node);
    const dst = this.alloc.alloc();
    const op = node.operator as string;

    const opMap: Record<string, number> = {
      '+': Op.ADD,
      '-': Op.SUB,
      '*': Op.MUL,
      '/': Op.DIV,
      '%': Op.MOD,
      '===': Op.EQ,
      '!==': Op.NEQ,
      '==': Op.LOOSE_EQ,
      '!=': Op.LOOSE_EQ, // will need to NOT the result
      '<': Op.LT,
      '<=': Op.LTE,
      '>': Op.GT,
      '>=': Op.GTE,
      '&': Op.BIT_AND,
      '|': Op.BIT_OR,
      '^': Op.BIT_XOR,
      '<<': Op.SHL,
      '>>': Op.SHR,
      '>>>': Op.USHR,
      '&&': Op.AND,
      '||': Op.OR,
      '??': Op.NULLISH,
    };

    const opcode = opMap[op];
    if (opcode === undefined) {
      throw new Error(`Unsupported operator: ${op}`);
    }

    // Handle src2 > 63 by using register number directly
    this.emit(opcode, dst, left, right);

    // For != (loose not equal), negate the result
    if (op === '!=') {
      this.emit(Op.NOT, dst, dst);
    }

    this.freeTemp(left);
    this.freeTemp(right);
    return dst;
  }

  private compileUnary(node: Node): number {
    const arg = this.compileExpression(node.argument as Node);
    const dst = this.alloc.alloc();
    const op = node.operator as string;

    switch (op) {
      case '-':
        this.emit(Op.NEG, dst, arg);
        break;
      case '!':
        this.emit(Op.NOT, dst, arg);
        break;
      case '~':
        this.emit(Op.BIT_NOT, dst, arg);
        break;
      case 'typeof':
        this.emit(Op.TYPEOF, dst, arg);
        break;
      case '+':
        this.emit(Op.TO_NUM, dst, arg);
        break;
      default:
        throw new Error(`Unsupported unary operator: ${op}`);
    }

    this.freeTemp(arg);
    return dst;
  }

  private compileAssignment(node: Node): number {
    const leftNode = node.left as Node;

    if (leftNode.type === 'Identifier') {
      const name = (leftNode as { name: string }).name;
      const variable = this.scope.lookup(name);
      if (!variable) throw new Error(`Undefined variable: ${name}`);

      const valReg = this.compileExpression(node.right as Node);
      const op = node.operator as string;

      if (op === '=') {
        this.emit(Op.MOV, variable.register, valReg);
      } else {
        const binOp: Record<string, number> = {
          '+=': Op.ADD,
          '-=': Op.SUB,
          '*=': Op.MUL,
          '/=': Op.DIV,
          '%=': Op.MOD,
          '&=': Op.BIT_AND,
          '|=': Op.BIT_OR,
          '^=': Op.BIT_XOR,
        };
        const opcode = binOp[op];
        if (!opcode) throw new Error(`Unsupported assignment operator: ${op}`);
        this.emit(opcode, variable.register, variable.register, valReg);
      }

      this.freeTemp(valReg);
      return variable.register;
    }

    if (leftNode.type === 'MemberExpression') {
      return this.compileMemberAssignment(leftNode, node.right as Node, node.operator as string);
    }

    throw new Error(`Unsupported assignment target: ${leftNode.type}`);
  }

  private compileMemberAssignment(member: Node, value: Node, op: string): number {
    const objReg = this.compileExpression(member.object as Node);
    const valReg = this.compileExpression(value);

    if (op !== '=') {
      throw new Error(`Compound member assignment not supported: ${op}`);
    }

    if (!member.computed && (member.property as Node).type === 'Identifier') {
      const propName = (member.property as Node as { name: string }).name;
      const propIdx = this.pool.addString(propName);
      this.emitOp(Op.SET_PROP_STR, objReg, valReg, 0, propIdx);
    } else {
      const propReg = this.compileExpression(member.property as Node);
      this.emitOp(Op.SET_PROP, objReg, propReg, 0, valReg);
      this.freeTemp(propReg);
    }

    this.freeTemp(valReg);
    return objReg;
  }

  private compileUpdate(node: Node): number {
    const arg = node.argument as Node;
    if (arg.type !== 'Identifier') {
      throw new Error('Update expression requires identifier');
    }

    const name = (arg as { name: string }).name;
    const variable = this.scope.lookup(name);
    if (!variable) throw new Error(`Undefined variable: ${name}`);

    const op = node.operator as string;
    const prefix = node.prefix as boolean;

    if (prefix) {
      this.emit(op === '++' ? Op.INC : Op.DEC, variable.register, variable.register);
      return variable.register;
    } else {
      // Postfix: save old value, then increment
      const oldReg = this.alloc.alloc();
      this.emit(Op.MOV, oldReg, variable.register);
      this.emit(op === '++' ? Op.INC : Op.DEC, variable.register, variable.register);
      return oldReg;
    }
  }

  private compileMemberExpression(node: Node): number {
    const objReg = this.compileExpression(node.object as Node);
    const dst = this.alloc.alloc();

    if (!node.computed && (node.property as Node).type === 'Identifier') {
      const propName = (node.property as Node as { name: string }).name;
      const propIdx = this.pool.addString(propName);
      this.emitOp(Op.GET_PROP_STR, dst, objReg, 0, propIdx);
    } else {
      const propReg = this.compileExpression(node.property as Node);
      this.emit(Op.GET_PROP, dst, objReg, propReg);
      this.freeTemp(propReg);
    }

    this.freeTemp(objReg);
    return dst;
  }

  private compileCallExpression(node: Node): number {
    const callee = node.callee as Node;
    const args = (node.arguments ?? []) as Node[];
    const dst = this.alloc.alloc();

    // Handle built-in calls
    if (callee.type === 'MemberExpression') {
      const obj = callee.object as Node;
      const prop = callee.property as Node;

      // Math.xxx(...)
      if (
        obj.type === 'Identifier' &&
        (obj as { name: string }).name === 'Math' &&
        prop.type === 'Identifier'
      ) {
        const fnName = (prop as { name: string }).name;
        const fnIdx = this.pool.addString(fnName);

        const argRegs: number[] = [];
        for (const arg of args) {
          argRegs.push(this.compileExpression(arg));
        }

        const src1 = argRegs[0] ?? 0;
        const src2 = argRegs[1] ?? 0;
        this.emitOp(Op.MATH_FN, dst, src1, src2, fnIdx);

        for (const r of argRegs) {
          this.freeTemp(r);
        }
        return dst;
      }

      // String/Array method calls: obj.method(args)
      if (prop.type === 'Identifier') {
        const methodName = (prop as { name: string }).name;
        return this.compileMethodCall(callee, methodName, args, dst);
      }
    }

    // Handle simple identifier calls
    if (callee.type === 'Identifier') {
      const name = (callee as { name: string }).name;
      return this.compileBuiltinCall(name, args, dst);
    }

    // Handle calling any expression (IIFE, function stored in variable, etc.)
    if (callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression') {
      const funcReg = this.compileFunctionExpr(callee);
      const argRegs: number[] = [];
      for (const arg of args) {
        argRegs.push(this.compileExpression(arg));
      }
      for (let i = 0; i < argRegs.length && i < 7; i++) {
        this.emit(Op.MOV, i + 1, argRegs[i]);
      }
      this.emit(Op.CALL_FUNC, dst, funcReg, argRegs.length);
      for (const r of argRegs) {
        this.freeTemp(r);
      }
      this.freeTemp(funcReg);
      return dst;
    }

    throw new Error(`Unsupported call expression: ${callee.type}`);
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- method dispatch table; each case is a distinct op
  private compileMethodCall(member: Node, method: string, args: Node[], dst: number): number {
    const objReg = this.compileExpression((member as { object: Node }).object);

    const methodMap: Record<string, number> = {
      // String methods
      includes: Op.STR_INCLUDES,
      indexOf: Op.STR_INDEX_OF,
      split: Op.STR_SPLIT,
      trim: Op.STR_TRIM,
      toLowerCase: Op.STR_TO_LOWER,
      toUpperCase: Op.STR_TO_UPPER,
      toString: Op.TO_STRING,
      charAt: Op.STR_CHAR_AT,
      // Array methods
      push: Op.ARR_PUSH,
    };

    const simpleOp = methodMap[method];
    if (simpleOp !== undefined) {
      if (args.length === 0) {
        // No-arg methods (trim, toLowerCase, etc.)
        this.emit(simpleOp, dst, objReg);
      } else {
        const argReg = this.compileExpression(args[0]);
        if (method === 'push') {
          this.emit(Op.ARR_PUSH, objReg, argReg);
          this.freeTemp(argReg);
          this.freeTemp(objReg);
          return dst;
        }
        this.emit(simpleOp, dst, objReg, argReg);
        this.freeTemp(argReg);
      }
      this.freeTemp(objReg);
      return dst;
    }

    // slice with end parameter
    if (method === 'slice' && args.length >= 1) {
      const startReg = this.compileExpression(args[0]);
      const endVal = args.length >= 2 ? (this.evaluateConstant(args[1]) ?? 0xffffffff) : 0xffffffff;
      this.emitOp(Op.STR_SLICE, dst, objReg, startReg, endVal);
      this.freeTemp(startReg);
      this.freeTemp(objReg);
      return dst;
    }

    // replace
    if (method === 'replace' && args.length >= 2) {
      const patReg = this.compileExpression(args[0]);
      const repReg = this.compileExpression(args[1]);
      this.emitOp(Op.STR_REPLACE, dst, objReg, patReg, repReg);
      this.freeTemp(patReg);
      this.freeTemp(repReg);
      this.freeTemp(objReg);
      return dst;
    }

    // concat
    if (method === 'concat' && args.length >= 1) {
      const argReg = this.compileExpression(args[0]);
      this.emit(Op.STR_CONCAT, dst, objReg, argReg);
      this.freeTemp(argReg);
      this.freeTemp(objReg);
      return dst;
    }

    // HOF methods — inline as loops with CALL_FUNC
    if (method === 'forEach' || method === 'map' || method === 'filter') {
      if (args.length < 1) throw new Error(`${method} requires a callback`);
      const callbackReg = this.compileExpression(args[0]);
      const result = this.compileArrayHOF(method, objReg, callbackReg, dst);
      this.freeTemp(callbackReg);
      this.freeTemp(objReg);
      return result;
    }

    if (method === 'reduce' && args.length >= 2) {
      const callbackReg = this.compileExpression(args[0]);
      const initReg = this.compileExpression(args[1]);
      const result = this.compileReduce(objReg, callbackReg, initReg, dst);
      this.freeTemp(callbackReg);
      this.freeTemp(initReg);
      this.freeTemp(objReg);
      return result;
    }

    // find / some / every
    if (method === 'find' || method === 'some' || method === 'every') {
      if (args.length < 1) throw new Error(`${method} requires a callback`);
      const callbackReg = this.compileExpression(args[0]);
      const result = this.compileArraySearch(method, objReg, callbackReg, dst);
      this.freeTemp(callbackReg);
      this.freeTemp(objReg);
      return result;
    }

    // Generic property call — get method as property, call as AJVM function
    const propIdx = this.pool.addString(method);
    const fnReg = this.alloc.alloc();
    this.emitOp(Op.GET_PROP_STR, fnReg, objReg, 0, propIdx);

    const argRegs: number[] = [];
    for (const arg of args) {
      argRegs.push(this.compileExpression(arg));
    }
    for (let i = 0; i < argRegs.length && i < 7; i++) {
      this.emit(Op.MOV, i + 1, argRegs[i]);
    }
    this.emit(Op.CALL_FUNC, dst, fnReg, argRegs.length);
    for (const r of argRegs) {
      this.freeTemp(r);
    }
    this.alloc.free(fnReg);
    this.freeTemp(objReg);
    return dst;
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- builtin dispatch table; each case is a distinct op
  private compileBuiltinCall(name: string, args: Node[], dst: number): number {
    switch (name) {
      case 'parseInt': {
        const argReg = this.compileExpression(args[0]);
        const radix =
          args.length >= 2
            ? this.compileExpression(args[1])
            : (() => {
                const r = this.alloc.alloc();
                this.emitOp(Op.LOAD_INT, r, 0, 0, 10);
                return r;
              })();
        this.emit(Op.PARSE_INT, dst, argReg, radix);
        this.freeTemp(argReg);
        this.freeTemp(radix);
        return dst;
      }
      case 'parseFloat': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.PARSE_FLOAT, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      case 'isNaN': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.IS_NAN, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      case 'isFinite': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.IS_FINITE, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      case 'String': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.TO_STRING, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      case 'Number': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.TO_NUM, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      case 'Boolean': {
        const argReg = this.compileExpression(args[0]);
        this.emit(Op.TO_BOOL, dst, argReg);
        this.freeTemp(argReg);
        return dst;
      }
      // API bridge intrinsics: __api_get(id), __api_call(id, ...args),
      // __api_call_async(id, ...args), __api_new(id, ...args)
      case '__api_get': {
        if (args.length < 1) throw new Error('__api_get requires at least 1 argument (apiId)');
        const apiId = this.evaluateConstant(args[0]);
        if (apiId === undefined || typeof apiId !== 'number') {
          throw new Error('__api_get: first argument must be a numeric literal');
        }
        const apiIndex = this.getApiIndex(apiId);
        this.emitOp(Op.API_GET, dst, 0, 0, apiIndex);
        return dst;
      }
      case '__api_call': {
        if (args.length < 1) throw new Error('__api_call requires at least 1 argument (apiId)');
        const apiId = this.evaluateConstant(args[0]);
        if (apiId === undefined || typeof apiId !== 'number') {
          throw new Error('__api_call: first argument must be a numeric literal');
        }
        const apiIndex = this.getApiIndex(apiId);
        // Remaining args go into R1-R7
        const argRegs: number[] = [];
        for (let i = 1; i < args.length; i++) {
          argRegs.push(this.compileExpression(args[i]));
        }
        for (let i = 0; i < argRegs.length && i < 7; i++) {
          this.emit(Op.MOV, i + 1, argRegs[i]);
        }
        this.emitOp(Op.API_CALL, dst, 0, argRegs.length, apiIndex);
        for (const r of argRegs) this.freeTemp(r);
        return dst;
      }
      case '__api_call_async': {
        if (args.length < 1)
          throw new Error('__api_call_async requires at least 1 argument (apiId)');
        const apiId = this.evaluateConstant(args[0]);
        if (apiId === undefined || typeof apiId !== 'number') {
          throw new Error('__api_call_async: first argument must be a numeric literal');
        }
        const apiIndex = this.getApiIndex(apiId);
        // Remaining args go into R1-R7
        const argRegs: number[] = [];
        for (let i = 1; i < args.length; i++) {
          argRegs.push(this.compileExpression(args[i]));
        }
        for (let i = 0; i < argRegs.length && i < 7; i++) {
          this.emit(Op.MOV, i + 1, argRegs[i]);
        }
        this.emitOp(Op.API_CALL_ASYNC, dst, 0, argRegs.length, apiIndex);
        for (const r of argRegs) this.freeTemp(r);
        return dst;
      }
      case '__api_new': {
        if (args.length < 1) throw new Error('__api_new requires at least 1 argument (apiId)');
        const apiId = this.evaluateConstant(args[0]);
        if (apiId === undefined || typeof apiId !== 'number') {
          throw new Error('__api_new: first argument must be a numeric literal');
        }
        const apiIndex = this.getApiIndex(apiId);
        // Remaining args go into R1-R7
        const argRegs: number[] = [];
        for (let i = 1; i < args.length; i++) {
          argRegs.push(this.compileExpression(args[i]));
        }
        for (let i = 0; i < argRegs.length && i < 7; i++) {
          this.emit(Op.MOV, i + 1, argRegs[i]);
        }
        this.emitOp(Op.API_NEW, dst, 0, argRegs.length, apiIndex);
        for (const r of argRegs) this.freeTemp(r);
        return dst;
      }
      default: {
        // Try calling a variable as a function
        const variable = this.scope.lookup(name);
        if (variable) {
          const argRegs: number[] = [];
          for (const arg of args) {
            argRegs.push(this.compileExpression(arg));
          }
          for (let i = 0; i < argRegs.length && i < 7; i++) {
            this.emit(Op.MOV, i + 1, argRegs[i]);
          }
          this.emit(Op.CALL_FUNC, dst, variable.register, argRegs.length);
          for (const r of argRegs) {
            this.freeTemp(r);
          }
          return dst;
        }
        throw new Error(`Unknown function: ${name}`);
      }
    }
  }

  private compileNewExpression(node: Node): number {
    const callee = node.callee as Node;
    const dst = this.alloc.alloc();

    if (callee.type === 'Identifier') {
      const name = (callee as { name: string }).name;
      switch (name) {
        case 'Object':
          this.emit(Op.OBJ_NEW, dst);
          return dst;
        case 'Array':
          this.emit(Op.ARR_NEW, dst);
          return dst;
        case 'Set':
          this.emit(Op.SET_NEW, dst);
          return dst;
        case 'Map':
          this.emit(Op.MAP_NEW, dst);
          return dst;
        default:
          throw new Error(`Unsupported constructor: new ${name}`);
      }
    }

    throw new Error(`Unsupported new expression: ${callee.type}`);
  }

  private compileObjectExpression(node: Node): number {
    const dst = this.alloc.alloc();
    this.emit(Op.OBJ_NEW, dst);

    const props = node.properties as Node[];
    for (const prop of props) {
      const key = prop.key as Node;
      const value = prop.value as Node;

      const valReg = this.compileExpression(value);

      if (key.type === 'Identifier') {
        const propIdx = this.pool.addString((key as { name: string }).name);
        this.emitOp(Op.SET_PROP_STR, dst, valReg, 0, propIdx);
      } else if (key.type === 'Literal') {
        const propIdx = this.pool.addString(String(key.value));
        this.emitOp(Op.SET_PROP_STR, dst, valReg, 0, propIdx);
      }

      this.freeTemp(valReg);
    }

    return dst;
  }

  private compileArrayExpression(node: Node): number {
    const dst = this.alloc.alloc();
    this.emit(Op.ARR_NEW, dst);

    const elements = node.elements as Node[];
    for (const el of elements) {
      if (el) {
        const elReg = this.compileExpression(el);
        this.emit(Op.ARR_PUSH, dst, elReg);
        this.freeTemp(elReg);
      }
    }

    return dst;
  }

  private compileConditional(node: Node): number {
    const testReg = this.compileExpression(node.test as Node);
    const dst = this.alloc.alloc();
    const elseLabel = this.label('ternary_else');
    const endLabel = this.label('ternary_end');

    this.emitJump(Op.JMP_FALSE, testReg, elseLabel);
    this.freeTemp(testReg);

    const consReg = this.compileExpression(node.consequent as Node);
    this.emit(Op.MOV, dst, consReg);
    this.freeTemp(consReg);
    this.emitJump(Op.JMP, 0, endLabel);

    this.markLabel(elseLabel);
    const altReg = this.compileExpression(node.alternate as Node);
    this.emit(Op.MOV, dst, altReg);
    this.freeTemp(altReg);

    this.markLabel(endLabel);
    return dst;
  }

  private compileTemplateLiteral(node: Node): number {
    const quasis = node.quasis as Node[];
    const expressions = node.expressions as Node[];

    // Start with first quasi
    const firstStr = (quasis[0] as { value: { cooked: string } }).value.cooked;
    let dst: number;

    if (firstStr) {
      dst = this.alloc.alloc();
      const idx = this.pool.addString(firstStr);
      this.emitOp(Op.LOAD_CONST_STR, dst, 0, 0, idx);
    } else {
      dst = this.alloc.alloc();
      const idx = this.pool.addString('');
      this.emitOp(Op.LOAD_CONST_STR, dst, 0, 0, idx);
    }

    for (let i = 0; i < expressions.length; i++) {
      const exprReg = this.compileExpression(expressions[i]);
      const strReg = this.alloc.alloc();
      this.emit(Op.TO_STRING, strReg, exprReg);
      this.emit(Op.STR_CONCAT, dst, dst, strReg);
      this.freeTemp(exprReg);
      this.alloc.free(strReg);

      // Add the next quasi
      const nextStr = (quasis[i + 1] as { value: { cooked: string } }).value.cooked;
      if (nextStr) {
        const nextReg = this.alloc.alloc();
        const idx = this.pool.addString(nextStr);
        this.emitOp(Op.LOAD_CONST_STR, nextReg, 0, 0, idx);
        this.emit(Op.STR_CONCAT, dst, dst, nextReg);
        this.alloc.free(nextReg);
      }
    }

    return dst;
  }

  /** Compile a function expression or arrow function into a MAKE_FUNC + body */
  private compileFunctionExpr(node: Node, destReg?: number): number {
    const params = (node.params ?? []) as Node[];
    const body = node.body as Node;

    // Step 1: Analyze free variables (outer vars referenced in the body)
    const paramNames = new Set(params.map((p: Node) => (p.name ?? p.left?.name) as string));
    const freeVars = this.findFreeVariables(body, paramNames);

    // Step 2: Map free vars to upvalue captures
    const upvalues: { name: string; outerReg: number }[] = [];
    for (const name of freeVars) {
      const v = this.scope.lookup(name);
      if (v) {
        upvalues.push({ name, outerReg: v.register });
      }
    }

    // Step 3: Emit JMP to skip over function body
    const skipLabel = this.label('skip_fn');
    const bodyLabel = this.label('fn_body');
    this.emitJump(Op.JMP, 0, skipLabel);

    // Step 4: Compile function body with fresh scope/allocator
    this.markLabel(bodyLabel);
    const outerScope = this.scope;
    const outerAlloc = this.alloc;
    this.scope = new Scope();
    this.alloc = new RegisterAllocator();

    // Copy parameters from R1-R7 to GP registers (safe across nested calls)
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const paramName = (param.name ?? param.left?.name) as string;
      const paramReg = this.alloc.alloc();
      this.emit(Op.MOV, paramReg, i + 1);
      this.scope.define(paramName, paramReg, 'param');
      // Handle default parameter values
      if (param.type === 'AssignmentPattern' && param.right) {
        const defaultLabel = this.label('param_default');
        const paramEndLabel = this.label('param_end');
        this.emit(Op.LOAD_UNDEF, 0);
        this.emit(Op.NEQ, 0, paramReg, 0);
        this.emitJump(Op.JMP_TRUE, 0, paramEndLabel);
        this.markLabel(defaultLabel);
        const defaultReg = this.compileExpression(param.right as Node);
        this.emit(Op.MOV, paramReg, defaultReg);
        this.freeTemp(defaultReg);
        this.markLabel(paramEndLabel);
      }
    }

    // Load upvalues into GP registers
    for (let i = 0; i < upvalues.length; i++) {
      const uvReg = this.alloc.alloc();
      this.emit(Op.LOAD_UPVAL, uvReg, i);
      this.scope.define(upvalues[i].name, uvReg, 'let');
    }

    // Compile the body
    if (body.type === 'BlockStatement') {
      const stmts = (body.body ?? []) as Node[];
      for (const stmt of stmts) {
        this.compileStatement(stmt);
      }
      // Implicit return undefined
      this.emit(Op.LOAD_UNDEF, 0);
      this.emit(Op.RET, 0, 0);
    } else {
      // Arrow function expression body: (x) => x + 1
      const resultReg = this.compileExpression(body);
      this.emit(Op.MOV, 0, resultReg);
      this.freeTemp(resultReg);
      this.emit(Op.RET, 0, 0);
    }

    // Restore outer scope/allocator
    this.scope = outerScope;
    this.alloc = outerAlloc;

    // Step 5: Mark skip label (main code continues here)
    this.markLabel(skipLabel);

    // Step 6: Emit MAKE_FUNC
    const dst = destReg ?? this.alloc.alloc();
    this.code.push(encodeInstruction(Op.MAKE_FUNC, 0, dst, params.length, 0));
    this.pendingJumps.push({ codeIndex: this.code.length, label: bodyLabel });
    this.code.push(0); // placeholder for code offset

    // Emit CAPTURE instructions for each upvalue
    for (const uv of upvalues) {
      this.emit(Op.CAPTURE, dst, uv.outerReg);
    }

    return dst;
  }

  /** Find identifiers in a function body that reference outer scope variables */
  private findFreeVariables(body: Node, params: Set<string>): Set<string> {
    const free = new Set<string>();
    const locals = new Set<string>(params);
    const builtins = new Set([
      'Math',
      'parseInt',
      'parseFloat',
      'isNaN',
      'isFinite',
      'String',
      'Number',
      'Boolean',
      'Object',
      'Array',
      'Set',
      'Map',
      'undefined',
      'null',
      'NaN',
      'Infinity',
      'true',
      'false',
      'console',
      'JSON',
    ]);

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- AST walk; each case handles a distinct node type
    const walk = (node: Node): void => {
      if (!node || typeof node !== 'object') return;

      switch (node.type) {
        case 'Identifier':
          if (!locals.has(node.name) && !builtins.has(node.name) && this.scope.lookup(node.name)) {
            free.add(node.name);
          }
          break;
        case 'VariableDeclaration':
          for (const decl of node.declarations ?? []) {
            if (decl.init) walk(decl.init);
            if (decl.id?.name) locals.add(decl.id.name);
          }
          return; // handled children manually
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'FunctionDeclaration': {
          // For nested functions, add their params as locals for the walk,
          // but still check references to our outer scope
          const nestedParams = new Set(locals);
          for (const p of node.params ?? []) {
            nestedParams.add((p.name ?? p.left?.name) as string);
          }
          if (node.id?.name) nestedParams.add(node.id.name);
          const nestedFree = this.findFreeVariablesInner(node.body, nestedParams, builtins);
          for (const name of nestedFree) {
            if (!locals.has(name) && !builtins.has(name) && this.scope.lookup(name)) {
              free.add(name);
            }
          }
          return; // handled
        }
        case 'MemberExpression':
          // Only walk the object part, not the property (unless computed)
          walk(node.object);
          if (node.computed) walk(node.property);
          return;
        case 'Property':
          // Walk value only (key is not a reference)
          walk(node.value);
          return;
        default:
          break;
      }

      // Walk all child nodes
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
          continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && item.type) walk(item);
          }
        } else if (child && typeof child === 'object' && child.type) {
          walk(child);
        }
      }
    };

    walk(body);
    return free;
  }

  /** Inner helper for nested function free variable analysis */
  private findFreeVariablesInner(
    body: Node,
    locals: Set<string>,
    builtins: Set<string>
  ): Set<string> {
    const free = new Set<string>();

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- AST walk; each branch handles a distinct node type
    const walk = (node: Node): void => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'Identifier') {
        if (!locals.has(node.name) && !builtins.has(node.name)) {
          free.add(node.name);
        }
        return;
      }
      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations ?? []) {
          if (decl.init) walk(decl.init);
          if (decl.id?.name) locals.add(decl.id.name);
        }
        return;
      }
      if (node.type === 'MemberExpression') {
        walk(node.object);
        if (node.computed) walk(node.property);
        return;
      }
      if (node.type === 'Property') {
        walk(node.value);
        return;
      }

      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
          continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && item.type) walk(item);
          }
        } else if (child && typeof child === 'object' && child.type) {
          walk(child);
        }
      }
    };

    walk(body);
    return free;
  }

  /** Compile arr.forEach/map/filter as inline loop + CALL_FUNC */
  private compileArrayHOF(
    method: string,
    arrReg: number,
    callbackReg: number,
    dst: number
  ): number {
    const idxReg = this.alloc.alloc();
    const lenReg = this.alloc.alloc();
    const loopLabel = this.label(`${method}_loop`);
    const endLabel = this.label(`${method}_end`);

    // Create result array for map/filter
    if (method === 'map' || method === 'filter') {
      this.emit(Op.ARR_NEW, dst);
    }

    // i = 0
    this.emitOp(Op.LOAD_INT, idxReg, 0, 0, 0);
    // len = arr.length
    this.emit(Op.ARR_LEN, lenReg, arrReg);

    this.markLabel(loopLabel);
    const cmpReg = this.alloc.alloc();
    this.emit(Op.LT, cmpReg, idxReg, lenReg);
    this.emitJump(Op.JMP_FALSE, cmpReg, endLabel);
    this.alloc.free(cmpReg);

    // elem = arr[i]
    const elemReg = this.alloc.alloc();
    this.emit(Op.ARR_GET, elemReg, arrReg, idxReg);

    // Set up args: R1=elem, R2=i, R3=arr
    this.emit(Op.MOV, 1, elemReg);
    this.emit(Op.MOV, 2, idxReg);
    this.emit(Op.MOV, 3, arrReg);

    // Call callback
    const callResultReg = this.alloc.alloc();
    this.emit(Op.CALL_FUNC, callResultReg, callbackReg, 3);

    if (method === 'map') {
      this.emit(Op.ARR_PUSH, dst, callResultReg);
    } else if (method === 'filter') {
      const skipLabel = this.label('filter_skip');
      this.emitJump(Op.JMP_FALSE, callResultReg, skipLabel);
      this.emit(Op.ARR_PUSH, dst, elemReg);
      this.markLabel(skipLabel);
    }

    this.alloc.free(callResultReg);
    this.alloc.free(elemReg);

    // i++
    this.emit(Op.INC, idxReg, idxReg);
    this.emitJump(Op.JMP, 0, loopLabel);

    this.markLabel(endLabel);
    this.alloc.free(idxReg);
    this.alloc.free(lenReg);

    if (method === 'forEach') {
      this.emit(Op.LOAD_UNDEF, dst);
    }

    return dst;
  }

  /** Compile arr.reduce(callback, init) as inline loop */
  private compileReduce(arrReg: number, callbackReg: number, initReg: number, dst: number): number {
    const idxReg = this.alloc.alloc();
    const lenReg = this.alloc.alloc();
    const accReg = this.alloc.alloc();
    const loopLabel = this.label('reduce_loop');
    const endLabel = this.label('reduce_end');

    this.emit(Op.MOV, accReg, initReg);
    this.emitOp(Op.LOAD_INT, idxReg, 0, 0, 0);
    this.emit(Op.ARR_LEN, lenReg, arrReg);

    this.markLabel(loopLabel);
    const cmpReg = this.alloc.alloc();
    this.emit(Op.LT, cmpReg, idxReg, lenReg);
    this.emitJump(Op.JMP_FALSE, cmpReg, endLabel);
    this.alloc.free(cmpReg);

    const elemReg = this.alloc.alloc();
    this.emit(Op.ARR_GET, elemReg, arrReg, idxReg);

    // R1=acc, R2=item, R3=index, R4=arr
    this.emit(Op.MOV, 1, accReg);
    this.emit(Op.MOV, 2, elemReg);
    this.emit(Op.MOV, 3, idxReg);
    this.emit(Op.MOV, 4, arrReg);

    this.emit(Op.CALL_FUNC, accReg, callbackReg, 4);
    this.alloc.free(elemReg);

    this.emit(Op.INC, idxReg, idxReg);
    this.emitJump(Op.JMP, 0, loopLabel);

    this.markLabel(endLabel);
    this.emit(Op.MOV, dst, accReg);
    this.alloc.free(idxReg);
    this.alloc.free(lenReg);
    this.alloc.free(accReg);

    return dst;
  }

  /** Compile arr.find/some/every as inline loop with early exit */
  private compileArraySearch(
    method: string,
    arrReg: number,
    callbackReg: number,
    dst: number
  ): number {
    const idxReg = this.alloc.alloc();
    const lenReg = this.alloc.alloc();
    const loopLabel = this.label(`${method}_loop`);
    const endLabel = this.label(`${method}_end`);
    const continueLabel = this.label(`${method}_cont`);

    this.emitOp(Op.LOAD_INT, idxReg, 0, 0, 0);
    this.emit(Op.ARR_LEN, lenReg, arrReg);

    // Default result
    if (method === 'find') {
      this.emit(Op.LOAD_UNDEF, dst);
    } else if (method === 'some') {
      this.emit(Op.LOAD_BOOL, dst, 0); // false
    } else {
      // every
      this.emit(Op.LOAD_BOOL, dst, 1); // true
    }

    this.markLabel(loopLabel);
    const cmpReg = this.alloc.alloc();
    this.emit(Op.LT, cmpReg, idxReg, lenReg);
    this.emitJump(Op.JMP_FALSE, cmpReg, endLabel);
    this.alloc.free(cmpReg);

    const elemReg = this.alloc.alloc();
    this.emit(Op.ARR_GET, elemReg, arrReg, idxReg);

    this.emit(Op.MOV, 1, elemReg);
    this.emit(Op.MOV, 2, idxReg);
    this.emit(Op.MOV, 3, arrReg);

    const callResultReg = this.alloc.alloc();
    this.emit(Op.CALL_FUNC, callResultReg, callbackReg, 3);

    // Check result — for find/some, truthy means done; for every, falsy means done
    if (method === 'every') {
      this.emitJump(Op.JMP_TRUE, callResultReg, continueLabel);
    } else {
      this.emitJump(Op.JMP_FALSE, callResultReg, continueLabel);
    }

    // Found! Set result and exit loop
    if (method === 'find') {
      this.emit(Op.MOV, dst, elemReg);
    } else if (method === 'some') {
      this.emit(Op.LOAD_BOOL, dst, 1);
    } else {
      // every
      this.emit(Op.LOAD_BOOL, dst, 0);
    }
    this.emitJump(Op.JMP, 0, endLabel);

    this.markLabel(continueLabel);
    this.alloc.free(callResultReg);
    this.alloc.free(elemReg);

    this.emit(Op.INC, idxReg, idxReg);
    this.emitJump(Op.JMP, 0, loopLabel);

    this.markLabel(endLabel);
    this.alloc.free(idxReg);
    this.alloc.free(lenReg);

    return dst;
  }

  private compileAwait(node: Node): number {
    const argReg = this.compileExpression(node.argument as Node);
    const dst = this.alloc.alloc();
    this.emit(Op.AWAIT, dst, argReg);
    this.freeTemp(argReg);
    return dst;
  }

  private evaluateConstant(node: Node): number | undefined {
    if (node.type === 'Literal' && typeof node.value === 'number') {
      return node.value;
    }
    return undefined;
  }

  /** Get the final bytecode as Uint32Array */
  getCode(): Uint32Array {
    return new Uint32Array(this.code);
  }
}
