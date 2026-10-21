import { Op } from './chunk';
import { Globals } from './globals';
import { BUILTIN_METHODS, iterate } from './natives';
import {
  BoundMethod, BriskList, BriskMap, Closure, DONE, type FnProto, FormatDepthError, Instance, Iter, Klass,
  NativeError, NativeFn, Range, Upvalue, type Value, format, isTruthy, typeName,
} from './value';

const FRAMES_MAX = 1024;
const STACK_MAX = FRAMES_MAX * 256;

interface Frame {
  closure: Closure;
  ip: number;
  base: number;
}

export class RuntimeError extends Error {
  constructor(message: string, readonly trace: string[], readonly line: number) {
    super(message);
  }
}

const OP_SYMBOL: Partial<Record<Op, string>> = { [Op.Sub]: '-', [Op.Mul]: '*', [Op.Div]: '/', [Op.Mod]: '%' };

export class VM {
  readonly globals = new Globals();
  private stack: Value[] = new Array(STACK_MAX).fill(null);
  private sp = 0;
  // frames are allocated once and reused; a call just bumps frameCount
  private frames: Frame[] = Array.from({ length: FRAMES_MAX }, () => ({ closure: null!, ip: 0, base: 0 }));
  private frameCount = 0;
  private openUpvalues: Upvalue | null = null;

  run(proto: FnProto): Value {
    const closure = new Closure(proto, []);
    this.sp = 0;
    this.openUpvalues = null;
    this.stack[this.sp++] = closure;
    const frame = this.frames[0];
    frame.closure = closure;
    frame.ip = 0;
    frame.base = 0;
    this.frameCount = 1;
    return this.execute();
  }

  private error(message: string, frame: Frame, ip: number): RuntimeError {
    frame.ip = ip;
    const trace: string[] = [];
    for (let i = this.frameCount - 1; i >= 0; i--) {
      const f = this.frames[i];
      const fn = f.closure.fn;
      const line = fn.chunk.lines[Math.max(f.ip - 1, 0)];
      trace.push(`  at ${fn.kind === 'script' ? '<script>' : fn.name + '()'} line ${line}`);
    }
    const line = frame.closure.fn.chunk.lines[Math.max(ip - 1, 0)];
    return new RuntimeError(message, trace, line);
  }

  private captureUpvalue(slot: number): Upvalue {
    let prev: Upvalue | null = null;
    let up = this.openUpvalues;
    while (up !== null && up.slot > slot) {
      prev = up;
      up = up.next;
    }
    if (up !== null && up.slot === slot) return up;

    const created = new Upvalue(slot);
    created.next = up;
    if (prev === null) this.openUpvalues = created;
    else prev.next = created;
    return created;
  }

  // move every captured variable at or above `slot` off the stack
  private closeUpvalues(slot: number) {
    while (this.openUpvalues !== null && this.openUpvalues.slot >= slot) {
      const up = this.openUpvalues;
      up.closed = this.stack[up.slot];
      up.open = false;
      this.openUpvalues = up.next;
    }
  }

  private execute(): Value {
    const stack = this.stack;
    const frames = this.frames;
    const gvals = this.globals.values;
    let frame = frames[this.frameCount - 1];
    let code = frame.closure.fn.chunk.code;
    let consts = frame.closure.fn.chunk.constants;
    let ip = frame.ip;
    let base = frame.base;
    let sp = this.sp;

    try {
      for (;;) {
        switch (code[ip++] as Op) {
          case Op.Const:
            stack[sp++] = consts[(code[ip] << 8) | code[ip + 1]];
            ip += 2;
            break;
          case Op.Nil: stack[sp++] = null; break;
          case Op.True: stack[sp++] = true; break;
          case Op.False: stack[sp++] = false; break;
          case Op.Pop: sp--; break;
          case Op.Dup:
            stack[sp] = stack[sp - 1];
            sp++;
            break;
          case Op.Dup2:
            stack[sp] = stack[sp - 2];
            stack[sp + 1] = stack[sp - 1];
            sp += 2;
            break;

          case Op.GetLocal:
            stack[sp++] = stack[base + code[ip++]];
            break;
          case Op.SetLocal:
            stack[base + code[ip++]] = stack[sp - 1];
            break;

          case Op.GetGlobal: {
            const slot = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            const value = gvals[slot];
            if (value === undefined) throw this.error(`Undefined variable '${this.globals.names[slot]}'`, frame, ip);
            stack[sp++] = value;
            break;
          }
          case Op.SetGlobal: {
            const slot = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            if (gvals[slot] === undefined) throw this.error(`Undefined variable '${this.globals.names[slot]}'`, frame, ip);
            gvals[slot] = stack[sp - 1];
            break;
          }
          case Op.DefineGlobal:
            gvals[(code[ip] << 8) | code[ip + 1]] = stack[--sp];
            ip += 2;
            break;

          case Op.GetUpvalue: {
            const up = frame.closure.upvalues[code[ip++]];
            stack[sp++] = up.open ? stack[up.slot] : up.closed;
            break;
          }
          case Op.SetUpvalue: {
            const up = frame.closure.upvalues[code[ip++]];
            if (up.open) stack[up.slot] = stack[sp - 1];
            else up.closed = stack[sp - 1];
            break;
          }
          case Op.CloseUpvalue:
            this.closeUpvalues(sp - 1);
            sp--;
            break;

          case Op.GetProp: {
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            ip += 2;
            const obj = stack[sp - 1];
            if (obj instanceof Instance) {
              const field = obj.fields.get(name);
              if (field !== undefined) {
                stack[sp - 1] = field;
                break;
              }
              const method = obj.klass.methods.get(name);
              if (method) {
                stack[sp - 1] = new BoundMethod(obj, method);
                break;
              }
              throw this.error(`${obj.klass.name} has no property '${name}'`, frame, ip);
            }
            const builtin = BUILTIN_METHODS[typeName(obj)]?.[name];
            if (builtin) {
              stack[sp - 1] = new BoundMethod(obj, builtin);
              break;
            }
            throw this.error(`${typeName(obj)} has no property '${name}'`, frame, ip);
          }
          case Op.SetProp: {
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            ip += 2;
            const obj = stack[sp - 2];
            if (!(obj instanceof Instance)) {
              throw this.error(`Can't set property '${name}' on a ${typeName(obj)}`, frame, ip);
            }
            const value = stack[sp - 1];
            obj.fields.set(name, value);
            stack[sp - 2] = value;
            sp--;
            break;
          }
          case Op.GetSuper: {
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            ip += 2;
            const superclass = stack[--sp] as Klass;
            const method = superclass.methods.get(name);
            if (!method) throw this.error(`${superclass.name} has no method '${name}'`, frame, ip);
            stack[sp - 1] = new BoundMethod(stack[sp - 1], method);
            break;
          }

          case Op.GetIndex: {
            const index = stack[--sp];
            stack[sp - 1] = this.getIndex(stack[sp - 1], index, frame, ip);
            break;
          }
          case Op.SetIndex: {
            const value = stack[--sp];
            const index = stack[--sp];
            this.setIndex(stack[sp - 1], index, value, frame, ip);
            stack[sp - 1] = value;
            break;
          }

          case Op.Eq: {
            const b = stack[--sp];
            stack[sp - 1] = stack[sp - 1] === b;
            break;
          }
          case Op.Neq: {
            const b = stack[--sp];
            stack[sp - 1] = stack[sp - 1] !== b;
            break;
          }

          // one case per operator: sharing a case and re-checking the opcode
          // inside cost ~15% on comparison-heavy loops
          case Op.Lt: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[sp - 1] = a < b;
            else stack[sp - 1] = this.compare(Op.Lt, a, b, frame, ip);
            break;
          }
          case Op.Le: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[sp - 1] = a <= b;
            else stack[sp - 1] = this.compare(Op.Le, a, b, frame, ip);
            break;
          }
          case Op.Gt: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[sp - 1] = a > b;
            else stack[sp - 1] = this.compare(Op.Gt, a, b, frame, ip);
            break;
          }
          case Op.Ge: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[sp - 1] = a >= b;
            else stack[sp - 1] = this.compare(Op.Ge, a, b, frame, ip);
            break;
          }

          case Op.Add: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a + b : this.add(a, b, frame, ip);
            break;
          }
          case Op.Sub: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Sub, a, b, frame, ip);
            stack[sp - 1] = a - b;
            break;
          }
          case Op.Mul: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Mul, a, b, frame, ip);
            stack[sp - 1] = a * b;
            break;
          }
          case Op.Div: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Div, a, b, frame, ip);
            if (b === 0) throw this.error('Division by zero', frame, ip);
            stack[sp - 1] = a / b;
            break;
          }
          case Op.Mod: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Mod, a, b, frame, ip);
            if (b === 0) throw this.error('Division by zero', frame, ip);
            stack[sp - 1] = a % b;
            break;
          }
          case Op.Neg: {
            const a = stack[sp - 1];
            if (typeof a !== 'number') throw this.error(`Can't negate a ${typeName(a)}`, frame, ip);
            stack[sp - 1] = -a;
            break;
          }
          case Op.Not:
            stack[sp - 1] = !isTruthy(stack[sp - 1]);
            break;

          case Op.Jump:
            ip += ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          case Op.JumpIfFalse: {
            const v = stack[sp - 1];
            ip += v === null || v === false ? ((code[ip] << 8) | code[ip + 1]) + 2 : 2;
            break;
          }
          case Op.JumpIfTrue: {
            const v = stack[sp - 1];
            ip += v !== null && v !== false ? ((code[ip] << 8) | code[ip + 1]) + 2 : 2;
            break;
          }
          case Op.PopJumpIfFalse: {
            const v = stack[--sp];
            ip += v === null || v === false ? ((code[ip] << 8) | code[ip + 1]) + 2 : 2;
            break;
          }
          case Op.Loop:
            ip = ip + 2 - ((code[ip] << 8) | code[ip + 1]);
            break;

          case Op.Call: {
            const argc = code[ip++];
            let callee = stack[sp - 1 - argc];

            // fast path: a plain closure call, the common case by far
            if (callee instanceof Closure) {
              const fn = callee.fn;
              if (argc !== fn.arity) throw this.arityError(fn.name, fn.arity, argc, frame, ip);
              if (this.frameCount === FRAMES_MAX) throw this.error('Stack overflow (too much recursion)', frame, ip);
              frame.ip = ip;
              frame = frames[this.frameCount++];
              frame.closure = callee;
              frame.base = base = sp - 1 - argc;
              code = fn.chunk.code;
              consts = fn.chunk.constants;
              ip = 0;
              break;
            }

            const target = this.resolveCall(callee, argc, sp, frame, ip);
            if (target === null) {
              sp = this.sp;
              break;
            }
            const fn = target.fn;
            if (argc !== fn.arity) throw this.arityError(fn.name, fn.arity, argc, frame, ip);
            if (this.frameCount === FRAMES_MAX) throw this.error('Stack overflow (too much recursion)', frame, ip);
            frame.ip = ip;
            frame = frames[this.frameCount++];
            frame.closure = target;
            frame.base = base = sp - 1 - argc;
            code = fn.chunk.code;
            consts = fn.chunk.constants;
            ip = 0;
            break;
          }

          case Op.Invoke:
          case Op.SuperInvoke: {
            const isSuper = code[ip - 1] === Op.SuperInvoke;
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            const argc = code[ip + 2];
            ip += 3;

            let method: Value;
            if (isSuper) {
              const superclass = stack[--sp] as Klass;
              const found = superclass.methods.get(name);
              if (!found) throw this.error(`${superclass.name} has no method '${name}'`, frame, ip);
              method = found;
            } else {
              const receiver = stack[sp - 1 - argc];
              if (receiver instanceof Instance) {
                const field = receiver.fields.get(name);
                if (field !== undefined) {
                  // a field holding something callable: call it as a plain value
                  stack[sp - 1 - argc] = field;
                  const target = this.resolveCall(field, argc, sp, frame, ip);
                  if (target === null) {
                    sp = this.sp;
                    break;
                  }
                  method = target;
                } else {
                  const found = receiver.klass.methods.get(name);
                  if (!found) throw this.error(`${receiver.klass.name} has no method '${name}'`, frame, ip);
                  method = found;
                }
              } else {
                const builtin = BUILTIN_METHODS[typeName(receiver)]?.[name];
                if (!builtin) throw this.error(`${typeName(receiver)} has no method '${name}'`, frame, ip);
                sp = this.callNative(builtin, argc, sp, frame, ip);
                break;
              }
            }

            const closure = method as Closure;
            const fn = closure.fn;
            if (argc !== fn.arity) throw this.arityError(fn.name, fn.arity, argc, frame, ip);
            if (this.frameCount === FRAMES_MAX) throw this.error('Stack overflow (too much recursion)', frame, ip);
            frame.ip = ip;
            frame = frames[this.frameCount++];
            frame.closure = closure;
            frame.base = base = sp - 1 - argc;
            code = fn.chunk.code;
            consts = fn.chunk.constants;
            ip = 0;
            break;
          }

          case Op.Closure: {
            const proto = consts[(code[ip] << 8) | code[ip + 1]] as FnProto;
            ip += 2;
            const upvalues = new Array<Upvalue>(proto.upvalueCount);
            for (let i = 0; i < proto.upvalueCount; i++) {
              const isLocal = code[ip++];
              const index = code[ip++];
              upvalues[i] = isLocal ? this.captureUpvalue(base + index) : frame.closure.upvalues[index];
            }
            stack[sp++] = new Closure(proto, upvalues);
            break;
          }

          case Op.Return: {
            const result = stack[--sp];
            if (this.openUpvalues !== null) this.closeUpvalues(base);
            if (--this.frameCount === 0) {
              this.sp = 0;
              return result;
            }
            sp = base;
            stack[sp++] = result;
            frame = frames[this.frameCount - 1];
            code = frame.closure.fn.chunk.code;
            consts = frame.closure.fn.chunk.constants;
            ip = frame.ip;
            base = frame.base;
            break;
          }

          case Op.Class: {
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            ip += 2;
            stack[sp++] = new Klass(name);
            break;
          }
          case Op.Inherit: {
            const superclass = stack[sp - 2];
            const subclass = stack[sp - 1] as Klass;
            if (!(superclass instanceof Klass)) throw this.error(`Can't inherit from a ${typeName(superclass)}`, frame, ip);
            // copy-down inheritance: methods defined later in the subclass overwrite these
            for (const [name, method] of superclass.methods) subclass.methods.set(name, method);
            subclass.init = superclass.init;
            subclass.superclass = superclass;
            sp--;
            break;
          }
          case Op.Method: {
            const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
            ip += 2;
            const klass = stack[sp - 2] as Klass;
            const method = stack[--sp] as Closure;
            klass.methods.set(name, method);
            if (name === 'init') klass.init = method;
            break;
          }

          case Op.List: {
            const n = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            const items = stack.slice(sp - n, sp);
            sp -= n;
            stack[sp++] = new BriskList(items);
            break;
          }
          case Op.Map: {
            const n = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            const map = new BriskMap();
            for (let i = sp - n * 2; i < sp; i += 2) map.entries.set(stack[i], stack[i + 1]);
            sp -= n * 2;
            stack[sp++] = map;
            break;
          }
          case Op.Range: {
            const to = stack[--sp];
            const from = stack[sp - 1];
            if (typeof from !== 'number' || typeof to !== 'number') {
              throw this.error(`Range bounds must be numbers, got ${typeName(from)} and ${typeName(to)}`, frame, ip);
            }
            stack[sp - 1] = new Range(from, to);
            break;
          }
          case Op.BuildString: {
            const n = code[ip++];
            let s = '';
            for (let i = sp - n; i < sp; i++) s += format(stack[i]);
            sp -= n;
            stack[sp++] = s;
            break;
          }

          case Op.Iter: {
            const it = iterate(stack[sp - 1]);
            if (!it) throw this.error(`Can't iterate over a ${typeName(stack[sp - 1])}`, frame, ip);
            stack[sp - 1] = it;
            break;
          }
          case Op.ForNext: {
            const it = stack[base + code[ip]] as Iter;
            const next = it.next();
            if (next === DONE) {
              ip += ((code[ip + 1] << 8) | code[ip + 2]) + 3;
            } else {
              stack[sp++] = next;
              ip += 3;
            }
            break;
          }

          case Op.JumpIfNotLt: {
            const b = stack[--sp];
            const a = stack[--sp];
            const ok = typeof a === 'number' && typeof b === 'number' ? a < b : this.compare(Op.Lt, a, b, frame, ip);
            ip += ok ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }
          case Op.JumpIfNotLe: {
            const b = stack[--sp];
            const a = stack[--sp];
            const ok = typeof a === 'number' && typeof b === 'number' ? a <= b : this.compare(Op.Le, a, b, frame, ip);
            ip += ok ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }
          case Op.JumpIfNotGt: {
            const b = stack[--sp];
            const a = stack[--sp];
            const ok = typeof a === 'number' && typeof b === 'number' ? a > b : this.compare(Op.Gt, a, b, frame, ip);
            ip += ok ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }
          case Op.JumpIfNotGe: {
            const b = stack[--sp];
            const a = stack[--sp];
            const ok = typeof a === 'number' && typeof b === 'number' ? a >= b : this.compare(Op.Ge, a, b, frame, ip);
            ip += ok ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }
          case Op.JumpIfNotEq: {
            const b = stack[--sp];
            const a = stack[--sp];
            ip += a === b ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }
          case Op.JumpIfNotNeq: {
            const b = stack[--sp];
            const a = stack[--sp];
            ip += a !== b ? 2 : ((code[ip] << 8) | code[ip + 1]) + 2;
            break;
          }

          case Op.AddLocal: {
            const slot = base + code[ip++];
            const b = stack[--sp];
            const a = stack[slot];
            stack[slot] = typeof a === 'number' && typeof b === 'number' ? a + b : this.add(a, b, frame, ip);
            break;
          }
          case Op.SubLocal: {
            const slot = base + code[ip++];
            const b = stack[--sp];
            const a = stack[slot];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Sub, a, b, frame, ip);
            stack[slot] = a - b;
            break;
          }
          case Op.AddGlobal: {
            const slot = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            const a = gvals[slot];
            if (a === undefined) throw this.error(`Undefined variable '${this.globals.names[slot]}'`, frame, ip);
            const b = stack[--sp];
            gvals[slot] = typeof a === 'number' && typeof b === 'number' ? a + b : this.add(a, b, frame, ip);
            break;
          }
          case Op.SubGlobal: {
            const slot = (code[ip] << 8) | code[ip + 1];
            ip += 2;
            const a = gvals[slot];
            if (a === undefined) throw this.error(`Undefined variable '${this.globals.names[slot]}'`, frame, ip);
            const b = stack[--sp];
            if (typeof a !== 'number' || typeof b !== 'number') throw this.arithError(Op.Sub, a, b, frame, ip);
            gvals[slot] = a - b;
            break;
          }

          default:
            throw this.error(`Unknown opcode ${code[ip - 1]}`, frame, ip);
        }
      }
    } catch (e) {
      // natives throw NativeError; give it a line number and a stack trace
      if (e instanceof NativeError || e instanceof FormatDepthError) throw this.error(e.message, frame, ip);
      throw e;
    }
  }

  // everything a call needs except pushing the frame. returns the closure to
  // enter, or null when the call already finished (natives, classes without init)
  private resolveCall(callee: Value, argc: number, sp: number, frame: Frame, ip: number): Closure | null {
    const stack = this.stack;
    if (callee instanceof BoundMethod) {
      stack[sp - 1 - argc] = callee.receiver;
      callee = callee.method;
    } else if (callee instanceof Klass) {
      stack[sp - 1 - argc] = new Instance(callee);
      if (callee.init === null) {
        if (argc !== 0) throw this.error(`${callee.name}() takes no arguments but got ${argc}`, frame, ip);
        this.sp = sp;
        return null;
      }
      callee = callee.init;
    }
    if (callee instanceof Closure) return callee;
    if (callee instanceof NativeFn) {
      this.sp = this.callNative(callee, argc, sp, frame, ip);
      return null;
    }
    throw this.error(`Can't call a ${typeName(callee)}`, frame, ip);
  }

  private callNative(fn: NativeFn, argc: number, sp: number, frame: Frame, ip: number): number {
    if (fn.arity !== -1 && argc !== fn.arity) throw this.arityError(fn.name, fn.arity, argc, frame, ip);
    const stack = this.stack;
    const args = stack.slice(sp - argc, sp);
    this.sp = sp;
    const result = fn.impl(args, stack[sp - 1 - argc]);
    sp -= argc;
    stack[sp - 1] = result;
    return sp;
  }

  private add(a: Value, b: Value, frame: Frame, ip: number): Value {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (a instanceof BriskList && b instanceof BriskList) return new BriskList([...a.items, ...b.items]);
    throw this.error(`Can't add ${typeName(a)} and ${typeName(b)}`, frame, ip);
  }

  private arityError(name: string, arity: number, argc: number, frame: Frame, ip: number) {
    return this.error(`${name}() takes ${arity} argument${arity === 1 ? '' : 's'} but got ${argc}`, frame, ip);
  }

  private arithError(op: Op, a: Value, b: Value, frame: Frame, ip: number) {
    return this.error(`Operands of '${OP_SYMBOL[op]}' must be numbers, got ${typeName(a)} and ${typeName(b)}`, frame, ip);
  }

  private compare(op: Op, a: Value, b: Value, frame: Frame, ip: number): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw this.error(`Can't compare ${typeName(a)} with ${typeName(b)}`, frame, ip);
    }
    return op === Op.Lt ? a < b : op === Op.Le ? a <= b : op === Op.Gt ? a > b : a >= b;
  }

  private getIndex(obj: Value, index: Value, frame: Frame, ip: number): Value {
    if (obj instanceof BriskList || typeof obj === 'string') {
      const len = typeof obj === 'string' ? obj.length : obj.items.length;
      const i = this.checkIndex(index, len, frame, ip);
      return typeof obj === 'string' ? obj[i] : obj.items[i];
    }
    if (obj instanceof BriskMap) return obj.entries.get(index) ?? null;
    throw this.error(`Can't index into a ${typeName(obj)}`, frame, ip);
  }

  private setIndex(obj: Value, index: Value, value: Value, frame: Frame, ip: number) {
    if (obj instanceof BriskList) {
      obj.items[this.checkIndex(index, obj.items.length, frame, ip)] = value;
    } else if (obj instanceof BriskMap) {
      obj.entries.set(index, value);
    } else {
      throw this.error(`Can't assign by index on a ${typeName(obj)}`, frame, ip);
    }
  }

  private checkIndex(index: Value, len: number, frame: Frame, ip: number): number {
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw this.error(`Index must be an integer, got ${typeName(index)}`, frame, ip);
    }
    const i = index < 0 ? len + index : index;
    if (i < 0 || i >= len) throw this.error(`Index ${index} out of range (length ${len})`, frame, ip);
    return i;
  }
}
