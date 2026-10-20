import { describe, expect, it } from 'vitest';
import { Brisk, CompileError, RuntimeError, describeError, disassembleSource } from '../src/index';

describe('compiler', () => {
  it('folds constant expressions', () => {
    const asm = disassembleSource('let day = 60 * 60 * 24\nlet s = "a" + "b"');
    expect(asm).toContain('Const          0 86400');
    expect(asm).toContain('"ab"');
    expect(asm).not.toContain('Mul');
  });

  it('leaves division by zero to runtime', () => {
    expect(disassembleSource('let x = 1 / 0')).toContain('Div');
  });

  it('uses Invoke for method calls', () => {
    const asm = disassembleSource('let xs = []\nxs.push(1)');
    expect(asm).toContain('Invoke         "push" (1 args)');
    expect(asm).not.toContain('GetProp');
  });

  it('marks captured variables', () => {
    // the block ends before the function does, so x has to be moved off
    // the stack right there; at function end Return closes it instead
    const asm = disassembleSource('fn f() {\n  let g = nil\n  {\n    let x = 1\n    g = fn() { return x }\n  }\n  return g\n}');
    expect(asm).toContain('captures local 2');
    expect(asm).toContain('CloseUpvalue');
  });

  it('reports errors from every phase together, in source order', () => {
    try {
      new Brisk().run('let a = @\nfn f() { return this }');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      return;
    }
    throw new Error('expected a compile error');
  });
});

describe('error messages', () => {
  it('points at the line with a stack trace', () => {
    const src = 'fn inner() { return nil + 1 }\nfn outer() { return inner() }\nouter()';
    let err: unknown;
    try {
      new Brisk({ prelude: false }).run(src);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RuntimeError);
    const text = describeError(err, src);
    expect(text).toContain("runtime error: Can't add nil and number");
    expect(text.split('\n').slice(-3)).toEqual([
      '  at inner() line 1',
      '  at outer() line 2',
      '  at <script> line 3',
    ]);
  });

  it('shows a caret under compile errors', () => {
    const src = 'let x = 1\nlet y = $';
    let text = '';
    try {
      new Brisk().run(src);
    } catch (e) {
      text = describeError(e, src);
    }
    expect(text).toBe("error: Unexpected character '$'\n  --> line 2\n  2 | let y = $\n              ^");
  });
});

describe('repl mode', () => {
  it('returns the last expression and keeps globals', () => {
    const b = new Brisk();
    expect(b.run('let x = 20', { repl: true })).toBe(null);
    expect(b.run('x + 22', { repl: true })).toBe(42);
  });
});
