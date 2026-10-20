import { type CompileOptions, compile } from './compiler';
import { disassemble } from './chunk';
import { type Diagnostic, tokenize } from './lexer';
import { PRELUDE, natives } from './natives';
import { parse } from './parser';
import type { FnProto, Value } from './value';
import { RuntimeError, VM } from './vm';

export { RuntimeError } from './vm';
export { format } from './value';
export type { Value } from './value';

export class CompileError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `line ${d.line}: ${d.message}`).join('\n'));
  }
}

export function compileSource(source: string, options?: CompileOptions): FnProto {
  const { tokens, errors: lexErrors } = tokenize(source);
  const { program, errors: parseErrors } = parse(tokens);
  const errors = [...lexErrors, ...parseErrors];
  if (errors.length) throw new CompileError(sortDiagnostics(errors));

  const { proto, errors: compileErrors } = compile(program, options);
  if (compileErrors.length) throw new CompileError(sortDiagnostics(compileErrors));
  return proto;
}

function sortDiagnostics(list: Diagnostic[]) {
  return [...list].sort((a, b) => a.line - b.line || a.col - b.col);
}

export function disassembleSource(source: string): string {
  return disassemble(compileSource(source)).join('\n');
}

export interface BriskOptions {
  print?: (line: string) => void;
  prelude?: boolean;
}

// one VM per instance; globals persist across run() calls, which is what the REPL wants
export class Brisk {
  private vm = new VM();

  constructor({ print = console.log, prelude = true }: BriskOptions = {}) {
    for (const fn of natives({ print })) this.vm.globals.set(fn.name, fn);
    if (prelude) this.vm.run(compileSource(PRELUDE));
  }

  run(source: string, options?: CompileOptions): Value {
    return this.vm.run(compileSource(source, options));
  }
}

// error message with the offending line underneath, for the CLI and playground
export function describeError(err: unknown, source: string): string {
  const lines = source.split('\n');
  const frame = (line: number, col: number) => {
    const text = lines[line - 1];
    if (text === undefined) return '';
    const gutter = `${line} | `;
    const caret = col > 0 ? '\n' + ' '.repeat(gutter.length + col - 1) + '^' : '';
    return `\n  ${gutter}${text}${caret ? caret.replace('\n', '\n  ') : ''}`;
  };

  if (err instanceof CompileError) {
    return err.diagnostics.map((d) => `error: ${d.message}\n  --> line ${d.line}${frame(d.line, d.col)}`).join('\n\n');
  }
  if (err instanceof RuntimeError) {
    return `runtime error: ${err.message}${frame(err.line, 0)}\n${err.trace.join('\n')}`;
  }
  return String(err);
}
