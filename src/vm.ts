import { Op } from './chunk';
import { BUILTIN_METHODS, iterate } from './natives';
import {
  BoundMethod, BriskList, BriskMap, Closure, DONE, type FnProto, Instance, Iter, Klass,
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

export class VM {
  readonly globals = new Map<string, Value>();
  private stack: Value[] = new Array(STACK_MAX).fill(null);
  private sp = 0;
  private frames: Frame[] = [];
  private openUpvalues: Upvalue | null = null;

  defineNative(name: string, arity: number, impl: (args: Value[]) => Value) {
    this.globals.set(name, new NativeFn(name, arity, impl));
  }

  run(proto: FnProto): Value {
    const closure = new Closure(proto, []);
    this.sp = 0;
    this.frames.length = 0;
    this.openUpvalues = null;
    this.stack[this.sp++] = closure;
    this.frames.push({ closure, ip: 0, base: 0 });
    return this.execute();
  }

  private error(message: string, frame: Frame, ip: number): RuntimeError {
    frame.ip = ip;
    const trace: string[] = [];
    for (let i = this.frames.length - 1; i >= 0; i--) {
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

  private bindMethod(klass: Klass, name: string, receiver: Value): BoundMethod | null {
    const method = klass.methods.get(name);
    return method ? new BoundMethod(receiver, method) : null;
  }

  private execute(): Value {
    const stack = this.stack;
    const globals = this.globals;
    let frame = this.frames[this.frames.length - 1];
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
              const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
              ip += 2;
              const value = globals.get(name);
              if (value === undefined) throw this.error(`Undefined variable '${name}'`, frame, ip);
              stack[sp++] = value;
              break;
            }
            case Op.SetGlobal: {
              const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
              ip += 2;
              if (!globals.has(name)) throw this.error(`Undefined variable '${name}'`, frame, ip);
              globals.set(name, stack[sp - 1]);
              break;
            }
            case Op.DefineGlobal: {
              const name = consts[(code[ip] << 8) | code[ip + 1]] as string;
              ip += 2;
              globals.set(name, stack[--sp]);
              break;
            }

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
                const bound = this.bindMethod(obj.klass, name, obj);
                if (bound) {
                  stack[sp - 1] = bound;
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
              const bound = this.bindMethod(superclass, name, stack[sp - 1]);
              if (!bound) throw this.error(`${superclass.name} has no method '${name}'`, frame, ip);
              stack[sp - 1] = bound;
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
            case Op.Lt: case Op.Le: case Op.Gt: case Op.Ge: {
              const op = code[ip - 1];
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) {
                throw this.error(`Can't compare ${typeName(a)} with ${typeName(b)}`, frame, ip);
              }
              stack[sp - 1] = op === Op.Lt ? a < b : op === Op.Le ? a <= b : op === Op.Gt ? a > b : a >= b;
              break;
            }

            case Op.Add: {
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (typeof a === 'number' && typeof b === 'number') stack[sp - 1] = a + b;
              else if (typeof a === 'string' && typeof b === 'string') stack[sp - 1] = a + b;
              else if (a instanceof BriskList && b instanceof BriskList) stack[sp - 1] = new BriskList([...a.items, ...b.items]);
              else throw this.error(`Can't add ${typeName(a)} and ${typeName(b)}`, frame, ip);
              break;
            }
            case Op.Sub: case Op.Mul: case Op.Div: case Op.Mod: {
              const op = code[ip - 1];
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (typeof a !== 'number' || typeof b !== 'number') {
                const sym = op === Op.Sub ? '-' : op === Op.Mul ? '*' : op === Op.Div ? '/' : '%';
                throw this.error(`Operands of '${sym}' must be numbers, got ${typeName(a)} and ${typeName(b)}`, frame, ip);
              }
              if (op === Op.Sub) stack[sp - 1] = a - b;
              else if (op === Op.Mul) stack[sp - 1] = a * b;
              else {
                if (b === 0) throw this.error('Division by zero', frame, ip);
                stack[sp - 1] = op === Op.Div ? a / b : a % b;
              }
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
              const off = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const v = stack[sp - 1];
              if (v === null || v === false) ip += off;
              break;
            }
            case Op.JumpIfTrue: {
              const off = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const v = stack[sp - 1];
              if (v !== null && v !== false) ip += off;
              break;
            }
            case Op.PopJumpIfFalse: {
              const off = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const v = stack[--sp];
              if (v === null || v === false) ip += off;
              break;
            }
            case Op.Loop:
              ip = ip + 2 - ((code[ip] << 8) | code[ip + 1]);
              break;

            case Op.Call:
            case Op.Invoke:
            case Op.SuperInvoke: {
              const op = code[ip - 1];
              let name = '';
              if (op !== Op.Call) {
                name = consts[(code[ip] << 8) | code[ip + 1]] as string;
                ip += 2;
              }
              const argc = code[ip++];

              let callee: Value;
              if (op === Op.Call) {
                callee = stack[sp - 1 - argc];
              } else if (op === Op.SuperInvoke) {
                const superclass = stack[--sp] as Klass;
                const method = superclass.methods.get(name);
                if (!method) throw this.error(`${superclass.name} has no method '${name}'`, frame, ip);
                callee = method;
              } else {
                const receiver = stack[sp - 1 - argc];
                if (receiver instanceof Instance) {
                  const field = receiver.fields.get(name);
                  if (field !== undefined) {
                    // a field holding a function: call it as a plain value
                    stack[sp - 1 - argc] = field;
                    callee = field;
                  } else {
                    const method = receiver.klass.methods.get(name);
                    if (!method) throw this.error(`${receiver.klass.name} has no method '${name}'`, frame, ip);
                    callee = method;
                  }
                } else {
                  const builtin = BUILTIN_METHODS[typeName(receiver)]?.[name];
                  if (!builtin) throw this.error(`${typeName(receiver)} has no method '${name}'`, frame, ip);
                  callee = new BoundMethod(receiver, builtin);
                }
              }

              // unwrap bound methods: the receiver becomes slot 0
              if (callee instanceof BoundMethod) {
                stack[sp - 1 - argc] = callee.receiver;
                callee = callee.method;
              }

              if (callee instanceof Klass) {
                stack[sp - 1 - argc] = new Instance(callee);
                if (callee.init === null) {
                  if (argc !== 0) throw this.error(`${callee.name}() takes no arguments but got ${argc}`, frame, ip);
                  sp -= argc;
                  break;
                }
                callee = callee.init;
              }

              if (callee instanceof Closure) {
                const fn = callee.fn;
                if (argc !== fn.arity) {
                  throw this.error(`${fn.name}() takes ${fn.arity} argument${fn.arity === 1 ? '' : 's'} but got ${argc}`, frame, ip);
                }
                if (this.frames.length === FRAMES_MAX) throw this.error('Stack overflow (too much recursion)', frame, ip);
                frame.ip = ip;
                frame = { closure: callee, ip: 0, base: sp - 1 - argc };
                this.frames.push(frame);
                code = fn.chunk.code;
                consts = fn.chunk.constants;
                ip = 0;
                base = frame.base;
                break;
              }

              if (callee instanceof NativeFn) {
                if (callee.arity !== -1 && argc !== callee.arity) {
                  throw this.error(`${callee.name}() takes ${callee.arity} argument${callee.arity === 1 ? '' : 's'} but got ${argc}`, frame, ip);
                }
                const args = stack.slice(sp - argc, sp);
                const receiver = stack[sp - 1 - argc];
                this.sp = sp;
                const result = callee.impl(args, receiver);
                sp -= argc;
                stack[sp - 1] = result;
                break;
              }

              throw this.error(`Can't call a ${typeName(callee)}`, frame, ip);
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
              this.closeUpvalues(base);
              this.frames.pop();
              if (this.frames.length === 0) {
                this.sp = 0;
                return result;
              }
              sp = base;
              stack[sp++] = result;
              frame = this.frames[this.frames.length - 1];
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
              const it = stack[base + code[ip++]] as Iter;
              const off = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const next = it.next();
              if (next === DONE) ip += off;
              else stack[sp++] = next;
              break;
            }

            default:
              throw this.error(`Unknown opcode ${code[ip - 1]}`, frame, ip);
        }
      }
    } catch (e) {
      // natives throw NativeError; give it a line number and a stack trace
      if (e instanceof NativeError) throw this.error(e.message, frame, ip);
      throw e;
    }
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
