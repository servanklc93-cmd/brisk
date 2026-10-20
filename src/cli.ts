import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Brisk, CompileError, describeError, disassembleSource, format } from './index';

const USAGE = `usage:
  brisk                  start the REPL
  brisk <file>           run a program
  brisk --disasm <file>  print the compiled bytecode
  brisk -e "<code>"      run a snippet`;

function runFile(path: string): number {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    console.error(`brisk: can't read ${path}`);
    return 66;
  }
  return runSource(source);
}

function runSource(source: string): number {
  try {
    new Brisk().run(source);
    return 0;
  } catch (e) {
    console.error(describeError(e, source));
    return e instanceof CompileError ? 65 : 70;
  }
}

function repl() {
  const brisk = new Brisk();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let buffer = '';

  console.log('brisk 0.1 — ctrl+d to exit');
  rl.prompt();

  rl.on('line', (line) => {
    buffer += line + '\n';
    // keep reading while brackets are still open
    if (depth(buffer) > 0) {
      rl.setPrompt('. ');
      rl.prompt();
      return;
    }
    const source = buffer;
    buffer = '';
    rl.setPrompt('> ');
    try {
      const value = brisk.run(source, { repl: true });
      if (value !== null) console.log(format(value, true));
    } catch (e) {
      console.error(describeError(e, source));
    }
    rl.prompt();
  });

  rl.on('close', () => process.stdout.write('\n'));
}

function depth(src: string): number {
  let d = 0;
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' && src[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '{' || c === '(' || c === '[') d++;
    if (c === '}' || c === ')' || c === ']') d--;
  }
  return d;
}

function main(argv: string[]): number {
  const [first, second] = argv;
  if (first === undefined) {
    repl();
    return 0;
  }
  if (first === '-h' || first === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (first === '-e' && second !== undefined) return runSource(second);
  if (first === '--disasm' && second !== undefined) {
    const source = readFileSync(second, 'utf8');
    try {
      console.log(disassembleSource(source));
      return 0;
    } catch (e) {
      console.error(describeError(e, source));
      return 65;
    }
  }
  if (first.startsWith('-')) {
    console.error(USAGE);
    return 64;
  }
  return runFile(first);
}

const code = main(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
