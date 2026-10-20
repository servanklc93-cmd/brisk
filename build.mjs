import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/brisk.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
});
chmodSync('dist/brisk.js', 0o755);

// the playground is a static site: html + one bundled script + a worker
mkdirSync('site', { recursive: true });
await build({
  entryPoints: ['playground/main.ts', 'playground/worker.ts'],
  outdir: 'site',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  loader: { '.brisk': 'text' },
});
cpSync('playground/index.html', 'site/index.html');
cpSync('playground/style.css', 'site/style.css');

console.log('built dist/brisk.js and site/');
