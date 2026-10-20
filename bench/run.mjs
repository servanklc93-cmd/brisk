// Runs each benchmark a few times in brisk and CPython and prints the best time.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const brisk = join(here, '..', 'dist', 'brisk.js');
const RUNS = 5;

const best = (cmd, args) =>
  Math.min(...Array.from({ length: RUNS }, () => Number(execFileSync(cmd, args, { encoding: 'utf8' }).trim())));

const python = process.env.PYTHON ?? 'python3';
const pyVersion = execFileSync(python, ['--version'], { encoding: 'utf8' }).trim();

console.log(`node ${process.version} vs ${pyVersion}, best of ${RUNS}\n`);
console.log('| benchmark | brisk | python | brisk vs python |');
console.log('|---|---:|---:|---:|');
for (const file of readdirSync(here).filter((f) => f.endsWith('.brisk')).sort()) {
  const name = file.replace('.brisk', '');
  const b = best('node', [brisk, join(here, file)]);
  const p = best(python, [join(here, name + '.py')]);
  const ratio = p / b;
  const verdict = ratio >= 1 ? `${ratio.toFixed(1)}x faster` : `${(1 / ratio).toFixed(1)}x slower`;
  console.log(`| ${name} | ${(b * 1000).toFixed(0)} ms | ${(p * 1000).toFixed(0)} ms | ${verdict} |`);
}
