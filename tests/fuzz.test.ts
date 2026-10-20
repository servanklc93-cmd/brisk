import { expect, it } from 'vitest';
import { Brisk, CompileError, RuntimeError } from '../src/index';

// Throw random token soup at the whole pipeline. Anything other than a
// CompileError or RuntimeError (a TypeError from inside the compiler, say)
// is a bug. Seeded so failures are reproducible.

const PIECES = [
  'let', 'fn', 'class', 'if', 'else', 'while', 'for', 'in', 'return', 'break', 'continue',
  'this', 'super', 'nil', 'true', 'x', 'y', 'f', '1', '2.5', '"s"', '"a${x}b"', '(', ')',
  '{', '}', '[', ']', ',', '.', '..', ':', ';', '+', '-', '*', '/', '%', '=', '==', '!',
  '<', '+=', 'and', 'or', '\n', '\n', ' ',
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

it('never crashes on random input', () => {
  const random = rng(42);
  for (let round = 0; round < 2000; round++) {
    const len = 1 + Math.floor(random() * 30);
    const src = Array.from({ length: len }, () => PIECES[Math.floor(random() * PIECES.length)]).join(' ');
    try {
      new Brisk({ print: () => {}, prelude: false }).run(src);
    } catch (e) {
      if (!(e instanceof CompileError || e instanceof RuntimeError)) {
        throw new Error(`crashed on round ${round}:\n${src}\n\n${(e as Error).stack}`);
      }
    }
  }
  expect(true).toBe(true);
});
