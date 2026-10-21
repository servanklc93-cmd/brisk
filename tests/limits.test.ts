import { describe, expect, it } from 'vitest';
import { Brisk, CompileError, RuntimeError } from '../src/index';

// Hostile inputs: none of these may escape as a raw JS error (RangeError from
// a blown stack, TypeError...). Each must end as a CompileError, a RuntimeError
// or a normal run.

function run(src: string) {
  const out: string[] = [];
  new Brisk({ print: (l) => out.push(l) }).run(src);
  return out;
}

function compileError(src: string): string {
  try {
    run(src);
  } catch (e) {
    if (e instanceof CompileError) return e.diagnostics[0].message;
    throw e;
  }
  throw new Error('expected a compile error');
}

function runtimeError(src: string): string {
  try {
    run(src);
  } catch (e) {
    if (e instanceof RuntimeError) return e.message;
    throw e;
  }
  throw new Error('expected a runtime error');
}

describe('nesting limits', () => {
  it('rejects 10k nested parentheses with a line number', () => {
    expect(compileError('print(' + '('.repeat(10000) + '1' + ')'.repeat(10000) + ')')).toMatch('nested more than 200 levels');
  });

  it('rejects deeply nested lists and unary operators', () => {
    expect(compileError('[' .repeat(10000) + ']'.repeat(10000))).toMatch('nested more than 200');
    expect(compileError('-'.repeat(10000) + '1')).toMatch('nested more than 200');
  });

  it('still allows reasonable nesting', () => {
    expect(run('print(' + '('.repeat(150) + '7' + ')'.repeat(150) + ')')).toEqual(['7']);
  });

  it('turns a 100k-term expression into a compile error instead of a crash', () => {
    expect(compileError('let x = 1\nprint(x + ' + Array(100000).fill('1').join(' + ') + ')')).toMatch('too deeply nested');
  });
});

describe('size limits', () => {
  it('list literals can be longer than 255 items', () => {
    expect(run('print(len([' + Array.from({ length: 1000 }, (_, i) => i).join(',') + ']))')).toEqual(['1000']);
  });

  it('reports too many locals and constants', () => {
    const locals = 'fn f() {\n' + Array.from({ length: 300 }, (_, i) => `let a${i} = 1`).join('\n') + '\n}';
    expect(compileError(locals)).toBe('Too many local variables in one function');
    const consts = Array.from({ length: 70000 }, (_, i) => `let v${i} = ${i}.5`).join('\n');
    expect(compileError(consts)).toMatch(/Too many (constants|global variables)/);
  });
});

describe('runtime limits', () => {
  it('printing a list nested 100k deep is an error, not a crash', () => {
    expect(runtimeError('let x = []\nfor i in 0..100000 { x = [x] }\nprint(x)')).toMatch("can't print it");
  });

  it('interpolating it is too', () => {
    expect(runtimeError('let x = []\nfor i in 0..1000 { x = [x] }\nlet s = "${x}"')).toMatch("can't print it");
  });

  it('recursion through methods, closures and init hits the frame limit', () => {
    expect(runtimeError('class A { m(n) { return this.m(n + 1) } }\nA().m(0)')).toMatch('Stack overflow');
    expect(runtimeError('let f = nil\nf = fn(n) { return f(n + 1) }\nf(0)')).toMatch('Stack overflow');
    expect(runtimeError('class A { init() { A() } }\nA()')).toMatch('Stack overflow');
  });

  it('a VM keeps working after a runtime error', () => {
    const b = new Brisk({ print: () => {} });
    expect(() => b.run('fn f() { return f() }\nf()')).toThrow(RuntimeError);
    expect(b.run('1 + 1', { repl: true })).toBe(2);
  });
});
