import { describe, expect, it } from 'vitest';
import type { Expr, Stmt } from '../src/ast';
import { tokenize } from '../src/lexer';
import { parse } from '../src/parser';

// compact s-expression form so precedence is easy to eyeball
function show(e: Expr): string {
  switch (e.kind) {
    case 'num': return String(e.value);
    case 'str': return JSON.stringify(e.value);
    case 'var': return e.name;
    case 'bool': return String(e.value);
    case 'nil': return 'nil';
    case 'unary': return `(${e.op} ${show(e.operand)})`;
    case 'binary': case 'logical': return `(${e.op} ${show(e.left)} ${show(e.right)})`;
    case 'assign': return `(${e.op} ${show(e.target)} ${show(e.value)})`;
    case 'call': return `(call ${show(e.callee)}${e.args.map((a) => ' ' + show(a)).join('')})`;
    case 'index': return `(index ${show(e.object)} ${show(e.index)})`;
    case 'get': return `(. ${show(e.object)} ${e.name})`;
    case 'list': return `[${e.items.map(show).join(' ')}]`;
    case 'interp': return `(interp ${e.parts.map((p) => (typeof p === 'string' ? JSON.stringify(p) : show(p))).join(' ')})`;
    default: return e.kind;
  }
}

function program(src: string) {
  const { tokens } = tokenize(src);
  return parse(tokens);
}

function expr(src: string): string {
  const { program: stmts, errors } = program(src);
  expect(errors).toEqual([]);
  const stmt = stmts[0] as Extract<Stmt, { kind: 'expr' }>;
  return show(stmt.expr);
}

describe('parser', () => {
  it('respects precedence', () => {
    expect(expr('1 + 2 * 3 - 4')).toBe('(- (+ 1 (* 2 3)) 4)');
    expect(expr('a or b and !c == d')).toBe('(or a (and b (== (! c) d)))');
    expect(expr('-a.b[0](1)')).toBe('(- (call (index (. a b) 0) 1))');
    expect(expr('0..n - 1')).toBe('(.. 0 (- n 1))');
  });

  it('assignment is right associative', () => {
    expect(expr('a = b = 3')).toBe('(= a (= b 3))');
    expect(expr('p.x += 1')).toBe('(+= (. p x) 1)');
  });

  it('parses interpolation', () => {
    expect(expr('"hi ${name}!"')).toBe('(interp "hi " name "!")');
    expect(expr('"${a}${b}"')).toBe('(interp a b)');
  });

  it('newlines end statements, but not inside calls', () => {
    const { program: stmts, errors } = program('let a = f(1,\n  2)\nprint(a)');
    expect(errors).toEqual([]);
    expect(stmts.map((s) => s.kind)).toEqual(['let', 'expr']);
  });

  it('a paren on the next line starts a new statement', () => {
    const { program: stmts } = program('f\n(1)');
    expect(stmts).toHaveLength(2);
  });

  it('bare return', () => {
    const { program: stmts, errors } = program('fn f() {\n  return\n}');
    expect(errors).toEqual([]);
    const body = (stmts[0] as Extract<Stmt, { kind: 'fndecl' }>).fn.body;
    expect(body[0]).toMatchObject({ kind: 'return', value: null });
  });

  it('names anonymous functions after their variable', () => {
    const { program: stmts } = program('let square = fn(x) { return x * x }');
    expect(stmts[0]).toMatchObject({ init: { fn: { name: 'square' } } });
  });

  it('collects several errors in one pass', () => {
    const { errors } = program('let = 1\nlet ok = 2\n1 + )\nlet x = (');
    expect(errors.map((e) => e.line)).toEqual([1, 3, 4]);
  });

  it('rejects bad assignment targets', () => {
    const { errors } = program('1 + 2 = 3');
    expect(errors[0].message).toMatch('Invalid assignment target');
  });

  it('two statements on one line need a semicolon', () => {
    expect(program('a b').errors[0].message).toMatch('Expected a newline or ;');
    expect(program('a; b').errors).toEqual([]);
  });

  it('never hangs on garbage', () => {
    const { errors } = program(') ) }\n] , .\nclass {');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('parser at end of input', () => {
  it('reports unterminated constructs instead of recursing', () => {
    for (const src of ['let x = (', 'f(1, ', '[1, 2', '{"a": ', 'fn f(', 'if x {', '"a ${b']) {
      const { errors } = program(src);
      expect(errors.length, src).toBeGreaterThan(0);
    }
  });
});
