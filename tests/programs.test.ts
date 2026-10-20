import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Brisk, CompileError, RuntimeError } from '../src/index';

// Each program lists what it should print in `// expect:` comments, or the
// error it should fail with. The runner checks the output matches exactly.

const dir = join(import.meta.dirname, 'programs');

describe('programs', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.brisk')).sort()) {
    it(file, () => {
      const source = readFileSync(join(dir, file), 'utf8');
      const expected = [...source.matchAll(/\/\/ expect: ?(.*)$/gm)].map((m) => m[1]);
      const runtimeError = source.match(/\/\/ expect runtime error: (.*)$/m)?.[1];
      const compileError = source.match(/\/\/ expect compile error: (.*)$/m)?.[1];

      const out: string[] = [];
      const brisk = new Brisk({ print: (line) => out.push(...line.split('\n')) });

      let error: unknown = null;
      try {
        brisk.run(source);
      } catch (e) {
        error = e;
      }

      if (compileError) {
        expect(error).toBeInstanceOf(CompileError);
        expect((error as CompileError).diagnostics.map((d) => d.message).join('\n')).toContain(compileError);
      } else if (runtimeError) {
        expect(error).toBeInstanceOf(RuntimeError);
        expect((error as RuntimeError).message).toBe(runtimeError);
      } else {
        if (error) throw error;
      }
      expect(out).toEqual(expected);
    });
  }
});
