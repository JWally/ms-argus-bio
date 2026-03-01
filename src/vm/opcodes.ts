/** Mini VM opcode definitions — stripped subset for tripwire */

export const Op = {
  // === Data movement (0x00-0x0F) ===
  MOV: 0x00,
  LOAD_CONST_STR: 0x01,
  LOAD_CONST_NUM: 0x02,
  LOAD_BOOL: 0x03,
  LOAD_NULL: 0x04,
  LOAD_UNDEF: 0x05,
  LOAD_INT: 0x06,

  // === Property access (0x10-0x1F) ===
  GET_PROP: 0x10,
  SET_PROP_STR: 0x13,
  GET_PROP_STR: 0x12,
  TYPEOF: 0x15,

  // === API bridge (0x20-0x2F) ===
  API_GET: 0x20,
  API_CALL: 0x21,
  API_CALL_ASYNC: 0x22,

  // === Arithmetic (0x30-0x3F) ===
  ADD: 0x30,
  SUB: 0x31,
  MUL: 0x32,
  DIV: 0x33,
  MOD: 0x34,
  NEG: 0x35,
  BIT_XOR: 0x38,
  INC: 0x3d,
  ABS: 0x3f,

  // === Comparison (0x40-0x4F) ===
  EQ: 0x40,
  NEQ: 0x41,
  LT: 0x42,
  LTE: 0x43,
  GT: 0x44,
  GTE: 0x45,
  NOT: 0x48,
  AND: 0x49,
  OR: 0x4a,

  // === Control flow (0x50-0x5F) ===
  JMP: 0x50,
  JMP_TRUE: 0x51,
  JMP_FALSE: 0x52,
  CALL: 0x53,
  RET: 0x54,
  HALT: 0x5a,

  // === Object/Array (0x60-0x6F) ===
  OBJ_NEW: 0x60,
  ARR_NEW: 0x61,
  ARR_PUSH: 0x62,
  ARR_GET: 0x63,
  ARR_LEN: 0x65,

  // === String (0x70-0x7F) ===
  STR_CONCAT: 0x70,
  STR_INCLUDES: 0x71,
  TO_STRING: 0x75,

  // === Utility (0x80-0x8F) ===
  MATH_FN: 0x82,
  TO_NUM: 0x80,

  // === Function/Closure (0x90-0x9F) ===
  MAKE_FUNC: 0x90,
  CALL_FUNC: 0x91,
  LOAD_UPVAL: 0x92,
  STORE_UPVAL: 0x93,
  CAPTURE: 0x94,
} as const;

export function hasOperand(opcode: number): boolean {
  switch (opcode) {
    case Op.LOAD_CONST_STR:
    case Op.LOAD_CONST_NUM:
    case Op.LOAD_INT:
    case Op.GET_PROP_STR:
    case Op.SET_PROP_STR:
    case Op.API_GET:
    case Op.API_CALL:
    case Op.API_CALL_ASYNC:
    case Op.JMP:
    case Op.JMP_TRUE:
    case Op.JMP_FALSE:
    case Op.CALL:
    case Op.MATH_FN:
    case Op.MAKE_FUNC:
      return true;
    default:
      return false;
  }
}
