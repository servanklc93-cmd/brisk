import type { Chunk } from './chunk';

export type Value =
  | number | string | boolean | null
  | Closure | NativeFn | BoundMethod | Klass | Instance
  | BriskList | BriskMap | Range | Iter | FnProto;

export type FnKind = 'script' | 'function' | 'method' | 'init';

export class FnProto {
  upvalueCount = 0;
  constructor(
    public name: string,
    public arity: number,
    public chunk: Chunk,
    public kind: FnKind,
  ) {}
}

export class Upvalue {
  // while open, the variable still lives on the VM stack at `slot`.
  // once its scope ends the value is copied into `closed`.
  closed: Value = null;
  open = true;
  next: Upvalue | null = null;
  constructor(public slot: number) {}
}

export class Closure {
  constructor(public fn: FnProto, public upvalues: Upvalue[]) {}
}

export class NativeError extends Error {}

export type NativeImpl = (args: Value[], receiver: Value) => Value;

export class NativeFn {
  // arity -1 means variadic
  constructor(public name: string, public arity: number, public impl: NativeImpl) {}
}

export class Klass {
  methods = new Map<string, Closure>();
  init: Closure | null = null;
  superclass: Klass | null = null;
  constructor(public name: string) {}
}

export class Instance {
  fields = new Map<string, Value>();
  constructor(public klass: Klass) {}
}

export class BoundMethod {
  constructor(public receiver: Value, public method: Closure | NativeFn) {}
}

export class BriskList {
  constructor(public items: Value[]) {}
}

export class BriskMap {
  constructor(public entries = new Map<Value, Value>()) {}
}

export class Range {
  constructor(public from: number, public to: number) {}
}

export const DONE = Symbol('done');

export class Iter {
  constructor(public next: () => Value | typeof DONE) {}
}

export function isTruthy(v: Value): boolean {
  return v !== null && v !== false;
}

export function typeName(v: Value): string {
  if (v === null) return 'nil';
  switch (typeof v) {
    case 'number': return 'number';
    case 'string': return 'string';
    case 'boolean': return 'bool';
  }
  if (v instanceof Closure || v instanceof NativeFn || v instanceof BoundMethod) return 'function';
  if (v instanceof BriskList) return 'list';
  if (v instanceof BriskMap) return 'map';
  if (v instanceof Klass) return 'class';
  if (v instanceof Instance) return v.klass.name;
  if (v instanceof Range) return 'range';
  return 'object';
}

export function format(v: Value, nested = false, seen = new Set<Value>()): string {
  if (v === null) return 'nil';
  if (typeof v === 'string') return nested ? JSON.stringify(v) : v;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'boolean') return String(v);

  if (v instanceof BriskList || v instanceof BriskMap) {
    if (seen.has(v)) return v instanceof BriskList ? '[...]' : '{...}';
    seen.add(v);
    const out = v instanceof BriskList
      ? `[${v.items.map((x) => format(x, true, seen)).join(', ')}]`
      : `{${[...v.entries].map(([k, x]) => `${format(k, true, seen)}: ${format(x, true, seen)}`).join(', ')}}`;
    seen.delete(v);
    return out;
  }

  if (v instanceof Closure) return `<fn ${v.fn.name}>`;
  if (v instanceof BoundMethod) return format(v.method);
  if (v instanceof NativeFn) return `<native fn ${v.name}>`;
  if (v instanceof Klass) return `<class ${v.name}>`;
  if (v instanceof Instance) return `<${v.klass.name} instance>`;
  if (v instanceof Range) return `${v.from}..${v.to}`;
  if (v instanceof FnProto) return `<proto ${v.name}>`;
  return '<iterator>';
}
