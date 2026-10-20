import { expect, it } from 'vitest';
import { Brisk } from '../src/index';

it('runs a program', () => {
  const out: string[] = [];
  const b = new Brisk({ print: (l) => out.push(l) });
  b.run(`
fn fib(n) {
  if n < 2 { return n }
  return fib(n - 1) + fib(n - 2)
}
print("fib(20) =", fib(20))
let xs = map([1, 2, 3], fn(x) { return x * x })
print(xs, sum(xs))
class Point {
  init(x, y) { this.x = x; this.y = y }
  str() { return "(\${this.x}, \${this.y})" }
}
class Point3 < Point {
  init(x, y, z) { super.init(x, y); this.z = z }
  str() { return super.str() + " z=\${this.z}" }
}
print(Point3(1, 2, 3).str())
fn counter() {
  let n = 0
  return fn() { n += 1; return n }
}
let c = counter()
c(); c()
print(c())
`);
  expect(out).toEqual(['fib(20) = 6765', '[1, 4, 9] 14', '(1, 2) z=3', '3']);
});
