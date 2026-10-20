import { FnProto, type Value, format } from './value';

// Operands follow the opcode in the byte stream. u8 = one byte, u16 = two (big endian).
export enum Op {
  Const,          // u16 constant index
  Nil, True, False,
  Pop,
  Dup,
  Dup2,
  GetLocal,       // u8 slot
  SetLocal,       // u8 slot
  GetGlobal,      // u16 global slot
  SetGlobal,      // u16 global slot
  DefineGlobal,   // u16 global slot
  GetUpvalue,     // u8 index
  SetUpvalue,     // u8 index
  CloseUpvalue,
  GetProp,        // u16 name
  SetProp,        // u16 name
  GetSuper,       // u16 name
  GetIndex,
  SetIndex,
  Eq, Neq, Lt, Le, Gt, Ge,
  Add, Sub, Mul, Div, Mod,
  Neg, Not,
  Jump,           // u16 forward offset
  JumpIfFalse,    // u16, leaves the condition on the stack
  JumpIfTrue,     // u16, leaves the condition on the stack
  PopJumpIfFalse, // u16, pops the condition
  Loop,           // u16 backward offset
  Call,           // u8 argc
  Invoke,         // u16 name, u8 argc
  SuperInvoke,    // u16 name, u8 argc
  Closure,        // u16 proto, then (u8 isLocal, u8 index) per upvalue
  Return,
  Class,          // u16 name
  Inherit,
  Method,         // u16 name
  List,           // u16 count
  Map,            // u16 pair count
  Range,
  BuildString,    // u8 part count
  Iter,
  ForNext,        // u8 iterator slot, u16 exit offset

  // superinstructions: fused versions of common sequences
  JumpIfNotLt,    // u16; pops both operands. `if a < b` in one dispatch
  JumpIfNotLe,
  JumpIfNotGt,
  JumpIfNotGe,
  JumpIfNotEq,
  JumpIfNotNeq,
  AddLocal,       // u8 slot; `x += <value>` as a statement, pops the value
  SubLocal,       // u8 slot
  AddGlobal,      // u16 global slot
  SubGlobal,      // u16 global slot
}

export class Chunk {
  code: number[] = [];
  lines: number[] = [];
  constants: Value[] = [];

  write(byte: number, line: number) {
    this.code.push(byte);
    this.lines.push(line);
  }

  addConstant(value: Value): number {
    // reuse slots for repeated strings and numbers, e.g. property names
    if (typeof value === 'string' || typeof value === 'number') {
      const existing = this.constants.indexOf(value);
      if (existing !== -1) return existing;
    }
    this.constants.push(value);
    return this.constants.length - 1;
  }
}

const U8 = new Set([Op.GetLocal, Op.SetLocal, Op.GetUpvalue, Op.SetUpvalue, Op.Call, Op.BuildString, Op.AddLocal, Op.SubLocal]);
const U16_CONST = new Set([Op.Const, Op.GetProp, Op.SetProp, Op.GetSuper, Op.Class, Op.Method]);
const GLOBALS = new Set([Op.GetGlobal, Op.SetGlobal, Op.DefineGlobal, Op.AddGlobal, Op.SubGlobal]);
const JUMPS = new Set([
  Op.Jump, Op.JumpIfFalse, Op.JumpIfTrue, Op.PopJumpIfFalse,
  Op.JumpIfNotLt, Op.JumpIfNotLe, Op.JumpIfNotGt, Op.JumpIfNotGe, Op.JumpIfNotEq, Op.JumpIfNotNeq,
]);

export function disassemble(proto: FnProto, globals: readonly string[] = [], out: string[] = []): string[] {
  const { chunk } = proto;
  const code = chunk.code;
  const nested: FnProto[] = [];
  out.push(`== ${proto.name} (arity ${proto.arity}) ==`);

  let ip = 0;
  let lastLine = -1;
  while (ip < code.length) {
    const at = ip;
    const op = code[ip++] as Op;
    const line = chunk.lines[at] === lastLine ? '   |' : String(chunk.lines[at]).padStart(4);
    lastLine = chunk.lines[at];
    const name = Op[op].padEnd(15);
    const u16 = () => {
      const v = (code[ip] << 8) | code[ip + 1];
      ip += 2;
      return v;
    };
    let args = '';

    if (U8.has(op)) {
      args = String(code[ip++]);
    } else if (U16_CONST.has(op)) {
      const idx = u16();
      args = `${idx} ${format(chunk.constants[idx], true)}`;
    } else if (GLOBALS.has(op)) {
      const slot = u16();
      args = `${slot} ${globals[slot] ?? '?'}`;
    } else if (JUMPS.has(op)) {
      const off = u16();
      args = `-> ${String(ip + off).padStart(4, '0')}`;
    } else if (op === Op.Loop) {
      const off = u16();
      args = `-> ${String(ip - off).padStart(4, '0')}`;
    } else if (op === Op.Invoke || op === Op.SuperInvoke) {
      const idx = u16();
      args = `${format(chunk.constants[idx], true)} (${code[ip++]} args)`;
    } else if (op === Op.List || op === Op.Map) {
      args = String(u16());
    } else if (op === Op.ForNext) {
      const slot = code[ip++];
      const off = u16();
      args = `slot ${slot}, done -> ${String(ip + off).padStart(4, '0')}`;
    } else if (op === Op.Closure) {
      const fn = chunk.constants[u16()] as FnProto;
      nested.push(fn);
      const ups: string[] = [];
      for (let i = 0; i < fn.upvalueCount; i++) {
        const isLocal = code[ip++];
        ups.push(`${isLocal ? 'local' : 'upvalue'} ${code[ip++]}`);
      }
      args = `<fn ${fn.name}>${ups.length ? '  captures ' + ups.join(', ') : ''}`;
    }

    out.push(`${String(at).padStart(4, '0')} ${line}  ${name}${args}`.trimEnd());
  }

  for (const fn of nested) {
    out.push('');
    disassemble(fn, globals, out);
  }
  return out;
}
