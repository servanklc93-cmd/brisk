import classes from '../examples/classes.brisk';
import closures from '../examples/closures.brisk';
import fib from '../examples/fib.brisk';
import fizzbuzz from '../examples/fizzbuzz.brisk';
import hello from '../examples/hello.brisk';
import life from '../examples/life.brisk';
import type { Request, Response } from './worker';

const EXAMPLES: Record<string, string> = {
  'hello.brisk': hello,
  'closures.brisk': closures,
  'classes.brisk': classes,
  'fib.brisk': fib,
  'life.brisk': life,
  'fizzbuzz.brisk': fizzbuzz,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const editor = $<HTMLTextAreaElement>('#editor');
const gutter = $<HTMLDivElement>('#gutter');
const output = $<HTMLPreElement>('#output');
const bytecode = $<HTMLPreElement>('#bytecode');
const status = $<HTMLSpanElement>('#status');
const runBtn = $<HTMLButtonElement>('#run');
const stopBtn = $<HTMLButtonElement>('#stop');
const examples = $<HTMLSelectElement>('#examples');

let worker = makeWorker();
let currentId = 0;
let running = false;

function makeWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<Response>) => handle(e.data);
  return w;
}

function handle(msg: Response) {
  if (msg.id !== currentId) return;
  switch (msg.type) {
    case 'print':
      output.append(msg.lines.join('\n') + '\n');
      output.scrollTop = output.scrollHeight;
      break;
    case 'done':
      setRunning(false, `finished in ${msg.ms.toFixed(1)} ms`);
      break;
    case 'error': {
      const span = document.createElement('span');
      span.className = 'error';
      span.textContent = msg.text + '\n';
      if (running) {
        output.append(span);
        setRunning(false, 'error');
      } else {
        bytecode.replaceChildren(span);
      }
      break;
    }
    case 'disasm':
      bytecode.textContent = msg.text;
      break;
  }
}

function send(mode: Request['mode']) {
  currentId++;
  worker.postMessage({ id: currentId, source: editor.value, mode } satisfies Request);
}

function setRunning(on: boolean, text: string) {
  running = on;
  runBtn.disabled = on;
  stopBtn.disabled = !on;
  status.textContent = text;
}

function run() {
  output.replaceChildren();
  setRunning(true, 'running…');
  send('run');
  refreshBytecode();
}

function stop() {
  // the only reliable way to stop `while true {}` is to kill the worker
  worker.terminate();
  worker = makeWorker();
  setRunning(false, 'stopped');
  output.append('[stopped]\n');
}

let disasmTimer = 0;
function refreshBytecode() {
  clearTimeout(disasmTimer);
  disasmTimer = window.setTimeout(() => {
    if (!running) send('disasm');
  }, 250);
}

let gutterLines = 0;
function updateGutter() {
  const lines = editor.value.split('\n').length;
  if (lines === gutterLines) return;
  gutterLines = lines;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}

function load(name: string) {
  editor.value = EXAMPLES[name];
  updateGutter();
  output.replaceChildren();
  status.textContent = '';
  refreshBytecode();
  history.replaceState(null, '', '#' + name);
}

for (const name of Object.keys(EXAMPLES)) examples.add(new Option(name, name));

examples.addEventListener('change', () => load(examples.value));
runBtn.addEventListener('click', run);
stopBtn.addEventListener('click', stop);

editor.addEventListener('input', () => {
  updateGutter();
  refreshBytecode();
});
editor.addEventListener('scroll', () => {
  gutter.scrollTop = editor.scrollTop;
});
editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!running) run();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    updateGutter();
  }
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    document.body.dataset.tab = tab.dataset.tab;
    if (tab.dataset.tab === 'bytecode') refreshBytecode();
  });
}

function loadFromHash() {
  const name = decodeURIComponent(location.hash.slice(1));
  const pick = name in EXAMPLES ? name : 'hello.brisk';
  examples.value = pick;
  load(pick);
}

window.addEventListener('hashchange', loadFromHash);
loadFromHash();
