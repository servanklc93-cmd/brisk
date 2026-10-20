import type { AssignOp, BinaryOp, Expr, FnNode, Stmt } from './ast';
import { Chunk, Op } from './chunk';
import type { Diagnostic } from './lexer';
import { FnProto, type FnKind, type Value } from './value';

interface Local {
  name: string;
  depth: number;
  captured: boolean;
}

interface UpvalueRef {
  index: number;
  isLocal: boolean;
}

interface Loop {
  start: number;
  // locals deeper than this belong to the loop body and get popped on break/continue
  depth: number;
  breaks: number[];
}

class FnState {
  locals: Local[] = [];
  upvalues: UpvalueRef[] = [];
  loops: Loop[] = [];
  depth = 0;

  constructor(
    readonly enclosing: FnState | null,
    readonly proto: FnProto,
  ) {
    // slot 0 holds the function being called, or `this` inside methods
    const kind = proto.kind;
    this.locals.push({ name: kind === 'method' || kind === 'init' ? 'this' : '', depth: 0, captured: false });
  }
}

interface ClassState {
  enclosing: ClassState | null;
  hasSuper: boolean;
}

class CompileAbort extends Error {}

const BINARY_OPS: Record<Exclude<BinaryOp, '..'>, Op> = {
  '+': Op.Add, '-': Op.Sub, '*': Op.Mul, '/': Op.Div, '%': Op.Mod,
  '==': Op.Eq, '!=': Op.Neq, '<': Op.Lt, '<=': Op.Le, '>': Op.Gt, '>=': Op.Ge,
};

const COMPOUND: Record<Exclude<AssignOp, '='>, Op> = {
  '+=': Op.Add, '-=': Op.Sub, '*=': Op.Mul, '/=': Op.Div,
};

export interface CompileOptions {
  // REPL mode: a trailing expression statement becomes the script's return value
  repl?: boolean;
}

export class Compiler {
  readonly errors: Diagnostic[] = [];
  private fn!: FnState;
  private klass: ClassState | null = null;
  private line = 1;

  compile(program: Stmt[], options: CompileOptions = {}): FnProto {
    const proto = new FnProto('<script>', 0, new Chunk(), 'script');
    this.fn = new FnState(null, proto);

    let last = program.length - 1;
    if (!options.repl || program[last]?.kind !== 'expr') last = program.length;
    for (let i = 0; i < last; i++) this.safely(() => this.stmt(program[i]));

    if (last < program.length) {
      const final = program[last] as Extract<Stmt, { kind: 'expr' }>;
      this.safely(() => this.expr(final.expr));
      this.emit(Op.Return);
    } else {
      this.emit(Op.Nil);
      this.emit(Op.Return);
    }
    return proto;
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof CompileAbort)) throw e;
    }
  }

  private error(message: string, line = this.line): never {
    this.errors.push({ message, line, col: 0 });
    throw new CompileAbort();
  }

  // --- emitting -------------------------------------------------------------

  private get chunk(): Chunk {
    return this.fn.proto.chunk;
  }

  private emit(...bytes: number[]) {
    for (const b of bytes) this.chunk.write(b, this.line);
  }

  private emitU16(op: Op, value: number) {
    this.emit(op, (value >> 8) & 0xff, value & 0xff);
  }

  private constant(value: Value): number {
    const idx = this.chunk.addConstant(value);
    if (idx > 0xffff) this.error('Too many constants in one function');
    return idx;
  }

  private emitJump(op: Op): number {
    this.emit(op, 0xff, 0xff);
    return this.chunk.code.length - 2;
  }

  private patchJump(at: number) {
    const offset = this.chunk.code.length - at - 2;
    if (offset > 0xffff) this.error('Too much code to jump over');
    this.chunk.code[at] = (offset >> 8) & 0xff;
    this.chunk.code[at + 1] = offset & 0xff;
  }

  private emitLoop(start: number) {
    const offset = this.chunk.code.length - start + 3;
    if (offset > 0xffff) this.error('Loop body too large');
    this.emitU16(Op.Loop, offset);
  }

  // --- scopes ---------------------------------------------------------------

  private beginScope() {
    this.fn.depth++;
  }

  private endScope() {
    const fn = this.fn;
    fn.depth--;
    while (fn.locals.length && fn.locals[fn.locals.length - 1].depth > fn.depth) {
      this.emit(fn.locals.pop()!.captured ? Op.CloseUpvalue : Op.Pop);
    }
  }

  // pop locals without forgetting them, for break / continue
  private discardLocals(depth: number) {
    const locals = this.fn.locals;
    for (let i = locals.length - 1; i >= 0 && locals[i].depth > depth; i--) {
      this.emit(locals[i].captured ? Op.CloseUpvalue : Op.Pop);
    }
  }

  private addLocal(name: string) {
    const fn = this.fn;
    for (let i = fn.locals.length - 1; i >= 0; i--) {
      const local = fn.locals[i];
      if (local.depth < fn.depth) break;
      if (local.name === name) this.error(`'${name}' is already declared in this scope`);
    }
    if (fn.locals.length >= 256) this.error('Too many local variables in one function');
    fn.locals.push({ name, depth: fn.depth, captured: false });
  }

  private isGlobalScope(): boolean {
    return this.fn.enclosing === null && this.fn.depth === 0;
  }

  // the value to bind is on top of the stack
  private define(name: string) {
    if (this.isGlobalScope()) this.emitU16(Op.DefineGlobal, this.constant(name));
    else this.addLocal(name);
  }

  private resolveLocal(fn: FnState, name: string): number {
    for (let i = fn.locals.length - 1; i >= 0; i--) {
      if (fn.locals[i].name === name) return i;
    }
    return -1;
  }

  private resolveUpvalue(fn: FnState, name: string): number {
    if (!fn.enclosing) return -1;
    const local = this.resolveLocal(fn.enclosing, name);
    if (local !== -1) {
      fn.enclosing.locals[local].captured = true;
      return this.addUpvalue(fn, local, true);
    }
    const up = this.resolveUpvalue(fn.enclosing, name);
    return up === -1 ? -1 : this.addUpvalue(fn, up, false);
  }

  private addUpvalue(fn: FnState, index: number, isLocal: boolean): number {
    const existing = fn.upvalues.findIndex((u) => u.index === index && u.isLocal === isLocal);
    if (existing !== -1) return existing;
    if (fn.upvalues.length >= 256) this.error('Too many captured variables in one function');
    fn.upvalues.push({ index, isLocal });
    fn.proto.upvalueCount = fn.upvalues.length;
    return fn.upvalues.length - 1;
  }

  private getVar(name: string) {
    let slot = this.resolveLocal(this.fn, name);
    if (slot !== -1) return this.emit(Op.GetLocal, slot);
    slot = this.resolveUpvalue(this.fn, name);
    if (slot !== -1) return this.emit(Op.GetUpvalue, slot);
    this.emitU16(Op.GetGlobal, this.constant(name));
  }

  private setVar(name: string) {
    let slot = this.resolveLocal(this.fn, name);
    if (slot !== -1) return this.emit(Op.SetLocal, slot);
    slot = this.resolveUpvalue(this.fn, name);
    if (slot !== -1) return this.emit(Op.SetUpvalue, slot);
    this.emitU16(Op.SetGlobal, this.constant(name));
  }

  // --- statements -----------------------------------------------------------

  private block(body: Stmt[]) {
    this.beginScope();
    for (const s of body) this.safely(() => this.stmt(s));
    this.endScope();
  }

  private stmt(s: Stmt) {
    this.line = s.line;
    switch (s.kind) {
      case 'expr':
        this.expr(s.expr);
        this.emit(Op.Pop);
        break;

      case 'let':
        // the initializer is compiled before the name exists, so
        // `let x = x` reads an outer x instead of itself
        if (s.init) this.expr(s.init);
        else this.emit(Op.Nil);
        this.line = s.line;
        this.define(s.name);
        break;

      case 'fndecl':
        if (this.isGlobalScope()) {
          this.function(s.fn, 'function');
          this.emitU16(Op.DefineGlobal, this.constant(s.fn.name));
        } else {
          // declare first so the function can call itself
          this.addLocal(s.fn.name);
          this.function(s.fn, 'function');
        }
        break;

      case 'block':
        this.block(s.body);
        break;

      case 'if': {
        this.expr(s.cond);
        const toElse = this.emitJump(Op.PopJumpIfFalse);
        this.block(s.then);
        if (s.else) {
          const toEnd = this.emitJump(Op.Jump);
          this.patchJump(toElse);
          this.block(s.else);
          this.patchJump(toEnd);
        } else {
          this.patchJump(toElse);
        }
        break;
      }

      case 'while': {
        const start = this.chunk.code.length;
        // `while true` needs no condition check at all
        const forever = s.cond.kind === 'bool' && s.cond.value;
        let exit = -1;
        if (!forever) {
          this.expr(s.cond);
          exit = this.emitJump(Op.PopJumpIfFalse);
        }
        const loop: Loop = { start, depth: this.fn.depth, breaks: [] };
        this.fn.loops.push(loop);
        this.block(s.body);
        this.emitLoop(start);
        this.fn.loops.pop();
        if (exit !== -1) this.patchJump(exit);
        loop.breaks.forEach((b) => this.patchJump(b));
        break;
      }

      case 'for':
        this.forIn(s);
        break;

      case 'return':
        if (this.fn.proto.kind === 'script') this.error("Can't return from top-level code");
        if (s.value) {
          if (this.fn.proto.kind === 'init') this.error("Can't return a value from init()");
          this.expr(s.value);
        } else if (this.fn.proto.kind === 'init') {
          this.emit(Op.GetLocal, 0);
        } else {
          this.emit(Op.Nil);
        }
        this.emit(Op.Return);
        break;

      case 'break':
      case 'continue': {
        const loop = this.fn.loops[this.fn.loops.length - 1];
        if (!loop) this.error(`'${s.kind}' outside of a loop`);
        this.discardLocals(loop.depth);
        if (s.kind === 'break') loop.breaks.push(this.emitJump(Op.Jump));
        else this.emitLoop(loop.start);
        break;
      }

      case 'class':
        this.classDecl(s);
        break;
    }
  }

  // for x in xs { body }
  //
  //        <xs>; Iter            iterator lives in a hidden local
  // start: ForNext it, exit      pushes the next item (the loop var) or jumps
  //        <body>
  //        Pop / CloseUpvalue    end of the per-iteration scope
  //        Loop start
  // exit:  Pop                   the iterator
  private forIn(s: Extract<Stmt, { kind: 'for' }>) {
    this.beginScope();
    this.expr(s.iterable);
    this.line = s.line;
    this.emit(Op.Iter);
    this.addLocal(' iter');
    const iterSlot = this.fn.locals.length - 1;

    const start = this.chunk.code.length;
    this.emit(Op.ForNext, iterSlot, 0xff, 0xff);
    const exit = this.chunk.code.length - 2;

    const loop: Loop = { start, depth: this.fn.depth, breaks: [] };
    this.fn.loops.push(loop);

    // a fresh scope per iteration, so closures capture each value separately
    this.beginScope();
    this.addLocal(s.name);
    for (const stmt of s.body) this.safely(() => this.stmt(stmt));
    this.endScope();
    this.emitLoop(start);

    this.fn.loops.pop();
    this.patchJump(exit);
    loop.breaks.forEach((b) => this.patchJump(b));
    this.endScope();
  }

  private classDecl(s: Extract<Stmt, { kind: 'class' }>) {
    const nameIdx = this.constant(s.name);
    this.emitU16(Op.Class, nameIdx);
    this.define(s.name);

    const state: ClassState = { enclosing: this.klass, hasSuper: false };
    this.klass = state;
    try {
      this.classBody(s, state);
    } finally {
      this.klass = state.enclosing;
    }
  }

  private classBody(s: Extract<Stmt, { kind: 'class' }>, state: ClassState) {
    if (s.superclass) {
      if (s.superclass === s.name) this.error("A class can't inherit from itself");
      this.getVar(s.superclass);
      this.beginScope();
      this.addLocal('super');
      this.getVar(s.name);
      this.emit(Op.Inherit);
      state.hasSuper = true;
    }

    this.getVar(s.name);
    for (const method of s.methods) {
      this.function(method, method.name === 'init' ? 'init' : 'method');
      this.line = method.line;
      this.emitU16(Op.Method, this.constant(method.name));
    }
    this.emit(Op.Pop);

    if (state.hasSuper) this.endScope();
  }

  private function(node: FnNode, kind: FnKind) {
    const proto = new FnProto(node.name || '<anon>', node.params.length, new Chunk(), kind);
    const enclosing = this.fn;
    const savedLine = this.line;
    this.fn = new FnState(enclosing, proto);
    this.line = node.line;

    let upvalues: UpvalueRef[];
    try {
      this.beginScope();
      for (const param of node.params) this.addLocal(param);
      for (const s of node.body) this.safely(() => this.stmt(s));

      // falling off the end returns nil (or `this` from init)
      this.line = node.body.length ? node.body[node.body.length - 1].line : node.line;
      if (kind === 'init') this.emit(Op.GetLocal, 0);
      else this.emit(Op.Nil);
      this.emit(Op.Return);
      upvalues = this.fn.upvalues;
    } finally {
      this.fn = enclosing;
      this.line = savedLine;
    }

    this.emitU16(Op.Closure, this.constant(proto));
    for (const up of upvalues) this.emit(up.isLocal ? 1 : 0, up.index);
  }

  // --- expressions ----------------------------------------------------------

  private expr(e: Expr) {
    this.line = e.line;
    switch (e.kind) {
      case 'num':
      case 'str':
        this.emitU16(Op.Const, this.constant(e.value));
        break;
      case 'bool':
        this.emit(e.value ? Op.True : Op.False);
        break;
      case 'nil':
        this.emit(Op.Nil);
        break;

      case 'interp':
        if (e.parts.length > 255) this.error('Too many parts in interpolated string');
        for (const part of e.parts) {
          if (typeof part === 'string') this.emitU16(Op.Const, this.constant(part));
          else this.expr(part);
        }
        this.line = e.line;
        this.emit(Op.BuildString, e.parts.length);
        break;

      case 'var':
        this.getVar(e.name);
        break;

      case 'assign':
        this.assign(e);
        break;

      case 'unary': {
        const folded = fold(e);
        if (folded !== undefined) {
          this.emitU16(Op.Const, this.constant(folded));
          break;
        }
        this.expr(e.operand);
        this.line = e.line;
        this.emit(e.op === '-' ? Op.Neg : Op.Not);
        break;
      }

      case 'binary': {
        const folded = fold(e);
        if (folded !== undefined) {
          this.emitU16(Op.Const, this.constant(folded));
          break;
        }
        this.expr(e.left);
        this.expr(e.right);
        this.line = e.line;
        this.emit(e.op === '..' ? Op.Range : BINARY_OPS[e.op]);
        break;
      }

      case 'logical': {
        this.expr(e.left);
        const skip = this.emitJump(e.op === 'and' ? Op.JumpIfFalse : Op.JumpIfTrue);
        this.emit(Op.Pop);
        this.expr(e.right);
        this.patchJump(skip);
        break;
      }

      case 'call':
        this.call(e);
        break;

      case 'index':
        this.expr(e.object);
        this.expr(e.index);
        this.line = e.line;
        this.emit(Op.GetIndex);
        break;

      case 'get':
        this.expr(e.object);
        this.line = e.line;
        this.emitU16(Op.GetProp, this.constant(e.name));
        break;

      case 'list':
        for (const item of e.items) this.expr(item);
        this.line = e.line;
        this.emitU16(Op.List, e.items.length);
        break;

      case 'map':
        if (e.entries.length > 0xffff) this.error('Too many entries in map literal');
        for (const [k, v] of e.entries) {
          this.expr(k);
          this.expr(v);
        }
        this.line = e.line;
        this.emitU16(Op.Map, e.entries.length);
        break;

      case 'fn':
        this.function(e.fn, 'function');
        break;

      case 'this':
        if (!this.klass) this.error("Can't use 'this' outside of a class");
        this.getVar('this');
        break;

      case 'super':
        this.checkSuper();
        this.getVar('this');
        this.getVar('super');
        this.line = e.line;
        this.emitU16(Op.GetSuper, this.constant(e.method));
        break;
    }
  }

  private checkSuper() {
    if (!this.klass) this.error("Can't use 'super' outside of a class");
    if (!this.klass.hasSuper) this.error("Can't use 'super' in a class with no superclass");
  }

  private call(e: Extract<Expr, { kind: 'call' }>) {
    const { callee, args } = e;

    // obj.method(args) skips creating a bound method object
    if (callee.kind === 'get') {
      this.expr(callee.object);
      for (const a of args) this.expr(a);
      this.line = e.line;
      this.emitU16(Op.Invoke, this.constant(callee.name));
      this.emit(args.length);
      return;
    }

    if (callee.kind === 'super') {
      this.checkSuper();
      this.getVar('this');
      for (const a of args) this.expr(a);
      this.getVar('super');
      this.line = e.line;
      this.emitU16(Op.SuperInvoke, this.constant(callee.method));
      this.emit(args.length);
      return;
    }

    this.expr(callee);
    for (const a of args) this.expr(a);
    this.line = e.line;
    this.emit(Op.Call, args.length);
  }

  private assign(e: Extract<Expr, { kind: 'assign' }>) {
    const { target, op, value } = e;
    const compound = op === '=' ? null : COMPOUND[op];

    if (target.kind === 'var') {
      if (compound !== null) this.getVar(target.name);
      this.expr(value);
      this.line = e.line;
      if (compound !== null) this.emit(compound);
      this.setVar(target.name);
      return;
    }

    if (target.kind === 'get') {
      this.expr(target.object);
      if (compound !== null) {
        this.emit(Op.Dup);
        this.emitU16(Op.GetProp, this.constant(target.name));
      }
      this.expr(value);
      this.line = e.line;
      if (compound !== null) this.emit(compound);
      this.emitU16(Op.SetProp, this.constant(target.name));
      return;
    }

    this.expr(target.object);
    this.expr(target.index);
    if (compound !== null) {
      this.emit(Op.Dup2);
      this.emit(Op.GetIndex);
    }
    this.expr(value);
    this.line = e.line;
    if (compound !== null) this.emit(compound);
    this.emit(Op.SetIndex);
  }
}

// constant folding: 60 * 60 * 24 compiles to a single constant
function fold(e: Expr): number | string | undefined {
  if (e.kind === 'num' || e.kind === 'str') return e.value;
  if (e.kind === 'unary' && e.op === '-') {
    const v = fold(e.operand);
    return typeof v === 'number' ? -v : undefined;
  }
  if (e.kind !== 'binary') return undefined;

  const a = fold(e.left);
  if (a === undefined) return undefined;
  const b = fold(e.right);
  if (b === undefined) return undefined;

  if (typeof a === 'string' && typeof b === 'string') return e.op === '+' ? a + b : undefined;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  switch (e.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    // leave division and modulo by zero to the VM so it can raise the error
    case '/': return b === 0 ? undefined : a / b;
    case '%': return b === 0 ? undefined : a % b;
    default: return undefined;
  }
}

export function compile(program: Stmt[], options?: CompileOptions) {
  const compiler = new Compiler();
  const proto = compiler.compile(program, options);
  return { proto, errors: compiler.errors };
}
