import type { Value } from './value';

// Globals are resolved to slot numbers at compile time, so the VM reads
// `values[slot]` instead of hashing the name on every access. Unset slots
// hold undefined, which no brisk value can be.
export class Globals {
  readonly names: string[] = [];
  readonly values: (Value | undefined)[] = [];
  private readonly index = new Map<string, number>();

  slot(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(name);
      this.values.push(undefined);
      this.index.set(name, i);
    }
    return i;
  }

  get(name: string): Value | undefined {
    const i = this.index.get(name);
    return i === undefined ? undefined : this.values[i];
  }

  set(name: string, value: Value) {
    this.values[this.slot(name)] = value;
  }
}
