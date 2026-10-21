import type { AssignOp, AssignTarget, BinaryOp, Expr, FnNode, Stmt } from './ast';
import { type Diagnostic, T, type Token } from './lexer';

class Abort extends Error {}

// deeper than this and the recursive descent would blow the JS stack.
// CPython has a similar limit (200 nested parentheses).
const MAX_NESTING = 200;

const ASSIGN_OPS: Partial<Record<T, AssignOp>> = {
  [T.Eq]: '=', [T.PlusEq]: '+=', [T.MinusEq]: '-=', [T.StarEq]: '*=', [T.SlashEq]: '/=',
};

const BINARY_LEVELS: [T, BinaryOp][][] = [
  [[T.EqEq, '=='], [T.BangEq, '!=']],
  [[T.Lt, '<'], [T.LtEq, '<='], [T.Gt, '>'], [T.GtEq, '>=']],
  [[T.DotDot, '..']],
  [[T.Plus, '+'], [T.Minus, '-']],
  [[T.Star, '*'], [T.Slash, '/'], [T.Percent, '%']],
];

export class Parser {
  private pos = 0;
  private nesting = 0;
  readonly errors: Diagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): Stmt[] {
    const program: Stmt[] = [];
    while (!this.check(T.EOF)) {
      const start = this.pos;
      try {
        program.push(this.declaration());
      } catch (e) {
        if (!(e instanceof Abort)) throw e;
        this.synchronize();
        // always make progress, or a bad token at a line start loops forever
        if (this.pos === start) this.advance();
      }
    }
    return program;
  }

  // --- helpers --------------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1];
  }

  private check(type: T): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    const token = this.peek();
    // at EOF, keep returning EOF; handing back the previous token here
    // made `let x = (` re-read the paren forever
    if (token.type !== T.EOF) this.pos++;
    return token;
  }

  private match(...types: T[]): boolean {
    if (types.includes(this.peek().type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: T, message: string): Token {
    if (this.check(type)) return this.advance();
    throw this.error(this.peek(), message);
  }

  private error(token: Token, message: string): Abort {
    const where = token.type === T.EOF ? 'end of file' : `'${token.text}'`;
    this.errors.push({ message: `${message} (found ${where})`, line: token.line, col: token.col });
    return new Abort();
  }

  // a statement ends at a semicolon, a newline, a closing brace or EOF
  private endStatement() {
    if (this.match(T.Semicolon)) return;
    const next = this.peek();
    if (next.nl || next.type === T.RBrace || next.type === T.EOF) return;
    throw this.error(next, 'Expected a newline or ; after statement');
  }

  private synchronize() {
    while (!this.check(T.EOF)) {
      if (this.previous()?.type === T.Semicolon) return;
      const t = this.peek();
      if (t.nl) return;
      switch (t.type) {
        case T.Let: case T.Fn: case T.Class: case T.If: case T.While: case T.For: case T.Return:
          return;
      }
      this.advance();
    }
  }

  // --- statements -----------------------------------------------------------

  private declaration(): Stmt {
    if (this.match(T.Let)) return this.letDecl();
    if (this.check(T.Fn) && this.tokens[this.pos + 1]?.type === T.Ident) {
      const line = this.advance().line;
      return { kind: 'fndecl', fn: this.fnRest(this.advance().text), line };
    }
    if (this.match(T.Class)) return this.classDecl();
    return this.statement();
  }

  private letDecl(): Stmt {
    const name = this.expect(T.Ident, 'Expected variable name');
    let init: Expr | null = null;
    if (this.match(T.Eq)) {
      init = this.expression();
      if (init.kind === 'fn' && init.fn.name === '') init.fn.name = name.text;
    }
    this.endStatement();
    return { kind: 'let', name: name.text, init, line: name.line };
  }

  private fnRest(name: string): FnNode {
    const line = this.previous().line;
    this.expect(T.LParen, 'Expected ( after function name');
    const params: string[] = [];
    if (!this.check(T.RParen)) {
      do {
        if (params.length >= 255) this.error(this.peek(), "Can't have more than 255 parameters");
        params.push(this.expect(T.Ident, 'Expected parameter name').text);
      } while (this.match(T.Comma));
    }
    this.expect(T.RParen, 'Expected ) after parameters');
    return { name, params, body: this.block(), line };
  }

  private classDecl(): Stmt {
    const name = this.expect(T.Ident, 'Expected class name');
    let superclass: string | null = null;
    if (this.match(T.Lt)) superclass = this.expect(T.Ident, 'Expected superclass name').text;
    this.expect(T.LBrace, 'Expected { before class body');
    const methods: FnNode[] = [];
    while (!this.check(T.RBrace) && !this.check(T.EOF)) {
      const method = this.expect(T.Ident, 'Expected method name');
      methods.push(this.fnRest(method.text));
    }
    this.expect(T.RBrace, 'Expected } after class body');
    return { kind: 'class', name: name.text, superclass, methods, line: name.line };
  }

  private block(): Stmt[] {
    this.expect(T.LBrace, 'Expected {');
    const body: Stmt[] = [];
    while (!this.check(T.RBrace) && !this.check(T.EOF)) {
      body.push(this.declaration());
    }
    this.expect(T.RBrace, 'Expected } to close block');
    return body;
  }

  private statement(): Stmt {
    const line = this.peek().line;

    if (this.match(T.If)) return this.ifRest();

    if (this.match(T.While)) {
      const cond = this.expression();
      return { kind: 'while', cond, body: this.block(), line };
    }

    if (this.match(T.For)) {
      const name = this.expect(T.Ident, 'Expected loop variable').text;
      this.expect(T.In, "Expected 'in' after loop variable");
      const iterable = this.expression();
      return { kind: 'for', name, iterable, body: this.block(), line };
    }

    if (this.match(T.Return)) {
      const next = this.peek();
      const bare = next.nl || next.type === T.RBrace || next.type === T.Semicolon || next.type === T.EOF;
      const value = bare ? null : this.expression();
      this.endStatement();
      return { kind: 'return', value, line };
    }

    if (this.match(T.Break)) {
      this.endStatement();
      return { kind: 'break', line };
    }

    if (this.match(T.Continue)) {
      this.endStatement();
      return { kind: 'continue', line };
    }

    if (this.check(T.LBrace)) return { kind: 'block', body: this.block(), line };

    const expr = this.expression();
    this.endStatement();
    return { kind: 'expr', expr, line };
  }

  private ifRest(): Stmt {
    const line = this.previous().line;
    const cond = this.expression();
    const then = this.block();
    let otherwise: Stmt[] | null = null;
    if (this.match(T.Else)) {
      otherwise = this.match(T.If) ? [this.ifRest()] : this.block();
    }
    return { kind: 'if', cond, then, else: otherwise, line };
  }

  // --- expressions ----------------------------------------------------------

  expression(): Expr {
    return this.assignment();
  }

  private assignment(): Expr {
    const expr = this.or();
    const op = ASSIGN_OPS[this.peek().type];
    if (op) {
      const token = this.advance();
      const value = this.assignment();
      if (expr.kind === 'var' || expr.kind === 'index' || expr.kind === 'get') {
        return { kind: 'assign', op, target: expr as AssignTarget, value, line: token.line };
      }
      this.error(token, 'Invalid assignment target');
    }
    return expr;
  }

  private or(): Expr {
    let left = this.and();
    while (this.match(T.Or)) {
      const line = this.previous().line;
      left = { kind: 'logical', op: 'or', left, right: this.and(), line };
    }
    return left;
  }

  private and(): Expr {
    let left = this.binary(0);
    while (this.match(T.And)) {
      const line = this.previous().line;
      left = { kind: 'logical', op: 'and', left, right: this.binary(0), line };
    }
    return left;
  }

  private binary(level: number): Expr {
    if (level === BINARY_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const entry = BINARY_LEVELS[level].find(([type]) => this.check(type));
      if (!entry) return left;
      const line = this.advance().line;
      const right = this.binary(level + 1);
      left = { kind: 'binary', op: entry[1], left, right, line };
      // a..b..c makes no sense, don't let it chain
      if (entry[1] === '..') return left;
    }
  }

  private unary(): Expr {
    // every nested expression passes through here, so this is where depth is counted
    if (++this.nesting > MAX_NESTING) {
      this.nesting = 0;
      throw this.error(this.peek(), `Expression is nested more than ${MAX_NESTING} levels deep`);
    }
    try {
      return this.unaryInner();
    } finally {
      if (this.nesting > 0) this.nesting--;
    }
  }

  private unaryInner(): Expr {
    if (this.match(T.Bang, T.Minus)) {
      const token = this.previous();
      const op = token.type === T.Bang ? '!' : '-';
      return { kind: 'unary', op, operand: this.unary(), line: token.line };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      const next = this.peek();
      // `foo\n(bar)` is two statements, not a call
      if (next.type === T.LParen && !next.nl) {
        this.advance();
        expr = { kind: 'call', callee: expr, args: this.args(T.RParen), line: next.line };
      } else if (next.type === T.LBracket && !next.nl) {
        this.advance();
        const index = this.expression();
        this.expect(T.RBracket, 'Expected ] after index');
        expr = { kind: 'index', object: expr, index, line: next.line };
      } else if (this.match(T.Dot)) {
        const name = this.expect(T.Ident, 'Expected property name after .');
        expr = { kind: 'get', object: expr, name: name.text, line: name.line };
      } else {
        return expr;
      }
    }
  }

  private args(close: T): Expr[] {
    const args: Expr[] = [];
    if (!this.check(close)) {
      do {
        if (this.check(close)) break; // trailing comma
        args.push(this.expression());
      } while (this.match(T.Comma));
    }
    this.expect(close, close === T.RParen ? 'Expected ) after arguments' : 'Expected ] after list');
    // calls encode argc in one byte; list literals use two
    if (close === T.RParen && args.length > 255) this.error(this.previous(), "Can't have more than 255 arguments");
    return args;
  }

  private primary(): Expr {
    const token = this.advance();
    const line = token.line;

    switch (token.type) {
      case T.Number: return { kind: 'num', value: token.value as number, line };
      case T.String: return { kind: 'str', value: token.value as string, line };
      case T.StringHead: return this.interpolation(token);
      case T.True: return { kind: 'bool', value: true, line };
      case T.False: return { kind: 'bool', value: false, line };
      case T.Nil: return { kind: 'nil', line };
      case T.This: return { kind: 'this', line };
      case T.Ident: return { kind: 'var', name: token.text, line };
      // already reported by the lexer
      case T.Error: return { kind: 'nil', line };

      case T.Super: {
        this.expect(T.Dot, "Expected '.' after 'super'");
        const method = this.expect(T.Ident, 'Expected superclass method name');
        return { kind: 'super', method: method.text, line };
      }

      case T.LParen: {
        const expr = this.expression();
        this.expect(T.RParen, 'Expected ) after expression');
        return expr;
      }

      case T.LBracket:
        return { kind: 'list', items: this.args(T.RBracket), line };

      case T.LBrace: {
        const entries: [Expr, Expr][] = [];
        while (!this.check(T.RBrace)) {
          const key = this.expression();
          this.expect(T.Colon, 'Expected : after map key');
          entries.push([key, this.expression()]);
          if (!this.match(T.Comma)) break;
        }
        this.expect(T.RBrace, 'Expected } after map entries');
        return { kind: 'map', entries, line };
      }

      case T.Fn:
        return { kind: 'fn', fn: this.fnRest(''), line };
    }

    throw this.error(token, 'Expected an expression');
  }

  private interpolation(head: Token): Expr {
    const parts: (string | Expr)[] = [];
    let token = head;
    for (;;) {
      if (token.value) parts.push(token.value as string);
      parts.push(this.expression());
      token = this.advance();
      if (token.type === T.String) {
        if (token.value) parts.push(token.value as string);
        return { kind: 'interp', parts, line: head.line };
      }
      if (token.type !== T.StringHead) throw this.error(token, 'Expected } to close ${ in string');
    }
  }
}

export function parse(tokens: Token[]): { program: Stmt[]; errors: Diagnostic[] } {
  const parser = new Parser(tokens);
  const program = parser.parse();
  return { program, errors: parser.errors };
}
