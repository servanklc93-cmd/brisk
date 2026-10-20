import {
  BriskList, BriskMap, DONE, Instance, Iter, Klass, NativeError, NativeFn, Range,
  type Value, format, isTruthy, typeName,
} from './value';

function fail(message: string): never {
  throw new NativeError(message);
}

function num(v: Value, fn: string): number {
  if (typeof v !== 'number') fail(`${fn}() expects a number, got ${typeName(v)}`);
  return v;
}

function str(v: Value, fn: string): string {
  if (typeof v !== 'string') fail(`${fn}() expects a string, got ${typeName(v)}`);
  return v;
}

function list(v: Value, fn: string): BriskList {
  if (!(v instanceof BriskList)) fail(`${fn}() expects a list, got ${typeName(v)}`);
  return v;
}

export function length(v: Value): number {
  if (typeof v === 'string') return v.length;
  if (v instanceof BriskList) return v.items.length;
  if (v instanceof BriskMap) return v.entries.size;
  return fail(`len() is not defined for ${typeName(v)}`);
}

export function iterate(v: Value): Iter | null {
  if (v instanceof BriskList) {
    let i = 0;
    const items = v.items;
    return new Iter(() => (i < items.length ? items[i++] : DONE));
  }
  if (v instanceof Range) {
    let cur = v.from;
    const { to } = v;
    return cur <= to
      ? new Iter(() => (cur < to ? cur++ : DONE))
      : new Iter(() => (cur > to ? cur-- : DONE));
  }
  if (v instanceof BriskMap) {
    const keys = [...v.entries.keys()];
    let i = 0;
    return new Iter(() => (i < keys.length ? keys[i++] : DONE));
  }
  if (typeof v === 'string') {
    const chars = [...v];
    let i = 0;
    return new Iter(() => (i < chars.length ? chars[i++] : DONE));
  }
  return null;
}

type Method = (self: never, args: Value[]) => Value;

function method(name: string, arity: number, impl: Method): [string, NativeFn] {
  return [name, new NativeFn(name, arity, (args, self) => impl(self as never, args))];
}

export const BUILTIN_METHODS: Record<string, Record<string, NativeFn>> = {
  list: Object.fromEntries([
    method('push', -1, (self: BriskList, args) => {
      self.items.push(...args);
      return self.items.length;
    }),
    method('pop', 0, (self: BriskList) => {
      if (!self.items.length) fail('pop() on an empty list');
      return self.items.pop()!;
    }),
    method('len', 0, (self: BriskList) => self.items.length),
    method('contains', 1, (self: BriskList, [x]) => self.items.includes(x)),
    method('indexOf', 1, (self: BriskList, [x]) => self.items.indexOf(x)),
    method('insert', 2, (self: BriskList, [i, x]) => {
      self.items.splice(num(i, 'insert'), 0, x);
      return null;
    }),
    method('removeAt', 1, (self: BriskList, [i]) => {
      const idx = num(i, 'removeAt');
      if (idx < 0 || idx >= self.items.length) fail(`removeAt() index ${idx} out of range`);
      return self.items.splice(idx, 1)[0];
    }),
    method('slice', 2, (self: BriskList, [a, b]) => new BriskList(self.items.slice(num(a, 'slice'), num(b, 'slice')))),
    method('reverse', 0, (self: BriskList) => new BriskList([...self.items].reverse())),
    method('join', 1, (self: BriskList, [sep]) => self.items.map((x) => format(x)).join(str(sep, 'join'))),
    method('sort', 0, (self: BriskList) => {
      const items = [...self.items];
      if (items.every((x) => typeof x === 'number')) (items as number[]).sort((a, b) => a - b);
      else if (items.every((x) => typeof x === 'string')) (items as string[]).sort();
      else fail('sort() needs a list of only numbers or only strings');
      return new BriskList(items);
    }),
  ]),

  string: Object.fromEntries([
    method('len', 0, (self: string) => self.length),
    method('upper', 0, (self: string) => self.toUpperCase()),
    method('lower', 0, (self: string) => self.toLowerCase()),
    method('trim', 0, (self: string) => self.trim()),
    method('contains', 1, (self: string, [x]) => self.includes(str(x, 'contains'))),
    method('startsWith', 1, (self: string, [x]) => self.startsWith(str(x, 'startsWith'))),
    method('split', 1, (self: string, [sep]) => new BriskList(self.split(str(sep, 'split')))),
    method('replace', 2, (self: string, [a, b]) => self.replaceAll(str(a, 'replace'), str(b, 'replace'))),
    method('slice', 2, (self: string, [a, b]) => self.slice(num(a, 'slice'), num(b, 'slice'))),
    method('repeat', 1, (self: string, [n]) => self.repeat(num(n, 'repeat'))),
  ]),

  map: Object.fromEntries([
    method('len', 0, (self: BriskMap) => self.entries.size),
    method('has', 1, (self: BriskMap, [k]) => self.entries.has(k)),
    method('get', 2, (self: BriskMap, [k, fallback]) => (self.entries.has(k) ? self.entries.get(k)! : fallback)),
    method('remove', 1, (self: BriskMap, [k]) => self.entries.delete(k)),
    method('keys', 0, (self: BriskMap) => new BriskList([...self.entries.keys()])),
    method('values', 0, (self: BriskMap) => new BriskList([...self.entries.values()])),
  ]),
};

export interface NativeOptions {
  print: (line: string) => void;
}

export function natives({ print }: NativeOptions): NativeFn[] {
  return [
    new NativeFn('print', -1, (args) => {
      print(args.map((a) => format(a)).join(' '));
      return null;
    }),
    new NativeFn('len', 1, ([v]) => length(v)),
    new NativeFn('str', 1, ([v]) => format(v)),
    new NativeFn('num', 1, ([v]) => {
      const text = str(v, 'num');
      const n = Number(text);
      return Number.isNaN(n) || text.trim() === '' ? null : n;
    }),
    new NativeFn('type', 1, ([v]) => typeName(v)),
    new NativeFn('clock', 0, () => performance.now() / 1000),
    new NativeFn('sqrt', 1, ([v]) => Math.sqrt(num(v, 'sqrt'))),
    new NativeFn('floor', 1, ([v]) => Math.floor(num(v, 'floor'))),
    new NativeFn('ceil', 1, ([v]) => Math.ceil(num(v, 'ceil'))),
    new NativeFn('round', 1, ([v]) => Math.round(num(v, 'round'))),
    new NativeFn('abs', 1, ([v]) => Math.abs(num(v, 'abs'))),
    new NativeFn('random', 0, () => Math.random()),
    new NativeFn('min', -1, (args) => Math.min(...args.map((a) => num(a, 'min')))),
    new NativeFn('max', -1, (args) => Math.max(...args.map((a) => num(a, 'max')))),
    new NativeFn('list', 1, ([v]) => {
      const iter = iterate(v);
      if (!iter) fail(`list() can't iterate over a ${typeName(v)}`);
      const out: Value[] = [];
      for (let x = iter.next(); x !== DONE; x = iter.next()) out.push(x);
      return new BriskList(out);
    }),
    new NativeFn('assert', -1, ([cond, message]) => {
      if (!isTruthy(cond ?? null)) fail(`assertion failed${message != null ? ': ' + format(message) : ''}`);
      return null;
    }),
    new NativeFn('error', 1, ([message]) => fail(format(message))),
    new NativeFn('isInstance', 2, ([obj, klass]) => {
      if (!(obj instanceof Instance)) return false;
      for (let k: Klass | null = obj.klass; k; k = k.superclass) {
        if (k === klass) return true;
      }
      return false;
    }),
  ];
}

// higher-order helpers are written in brisk itself
export const PRELUDE = `
fn map(xs, f) {
  let out = []
  for x in xs { out.push(f(x)) }
  return out
}

fn filter(xs, f) {
  let out = []
  for x in xs { if f(x) { out.push(x) } }
  return out
}

fn reduce(xs, f, acc) {
  for x in xs { acc = f(acc, x) }
  return acc
}

fn sum(xs) {
  return reduce(xs, fn(a, b) { return a + b }, 0)
}

fn enumerate(xs) {
  let out = []
  let i = 0
  for x in xs {
    out.push([i, x])
    i += 1
  }
  return out
}
`;
