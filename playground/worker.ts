import { Brisk, describeError, disassembleSource } from '../src/index';

export type Request = { id: number; source: string; mode: 'run' | 'disasm' };
export type Response =
  | { id: number; type: 'print'; lines: string[] }
  | { id: number; type: 'done'; ms: number }
  | { id: number; type: 'disasm'; text: string }
  | { id: number; type: 'error'; text: string };

const post = (msg: Response) => self.postMessage(msg);

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, source, mode } = event.data;

  if (mode === 'disasm') {
    try {
      post({ id, type: 'disasm', text: disassembleSource(source) });
    } catch (e) {
      post({ id, type: 'error', text: describeError(e, source) });
    }
    return;
  }

  // batch prints so a loop printing 10k lines doesn't flood the main thread
  let pending: string[] = [];
  let lastFlush = performance.now();
  const flush = () => {
    if (pending.length) post({ id, type: 'print', lines: pending });
    pending = [];
    lastFlush = performance.now();
  };

  const brisk = new Brisk({
    print: (line) => {
      pending.push(line);
      if (pending.length > 200 || performance.now() - lastFlush > 50) flush();
    },
  });

  const start = performance.now();
  try {
    brisk.run(source);
    flush();
    post({ id, type: 'done', ms: performance.now() - start });
  } catch (e) {
    flush();
    post({ id, type: 'error', text: describeError(e, source) });
  }
};
