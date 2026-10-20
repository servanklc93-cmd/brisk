export enum T {
  LParen, RParen, LBrace, RBrace, LBracket, RBracket,
  Comma, Dot, DotDot, Colon, Semicolon,
  Plus, Minus, Star, Slash, Percent,
  Bang, BangEq, Eq, EqEq, Lt, LtEq, Gt, GtEq,
  PlusEq, MinusEq, StarEq, SlashEq,
  Ident, Number, String,
  // "abc ${" — the start (or middle) of an interpolated string
  StringHead,
  And, Or, Class, Else, False, Fn, For, If, In, Let, Nil, Return, Super, This, True, While, Break, Continue,
  EOF,
}

export interface Token {
  type: T;
  text: string;
  value?: number | string;
  line: number;
  col: number;
  // true if a newline came between this token and the previous one.
  // statements end at newlines, so the parser needs to know.
  nl: boolean;
}

export interface Diagnostic {
  message: string;
  line: number;
  col: number;
}

const KEYWORDS: Record<string, T> = {
  and: T.And, or: T.Or, class: T.Class, else: T.Else, false: T.False, fn: T.Fn,
  for: T.For, if: T.If, in: T.In, let: T.Let, nil: T.Nil, return: T.Return,
  super: T.Super, this: T.This, true: T.True, while: T.While,
  break: T.Break, continue: T.Continue,
};

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$', '0': '\0' };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

export function tokenize(src: string): { tokens: Token[]; errors: Diagnostic[] } {
  const tokens: Token[] = [];
  const errors: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let nl = false;

  // brace depth bookkeeping for "${ ... }": when a `}` brings us back to the
  // depth an interpolation was opened at, we're back inside the string
  let depth = 0;
  const interpolations: number[] = [];

  const peek = (o = 0) => src[i + o] ?? '\0';
  const advance = () => {
    const c = src[i++];
    if (c === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return c;
  };
  const push = (type: T, text: string, l: number, c: number, value?: number | string) => {
    tokens.push({ type, text, value, line: l, col: c, nl });
    nl = false;
  };
  const error = (message: string, l = line, c = col) => errors.push({ message, line: l, col: c });

  function string(l: number, c: number) {
    let out = '';
    while (i < src.length && peek() !== '"') {
      const ch = peek();
      if (ch === '\\') {
        advance();
        const esc = advance() ?? '';
        if (esc in ESCAPES) out += ESCAPES[esc];
        else error(`Unknown escape sequence '\\${esc}'`, line, col - 2);
        continue;
      }
      if (ch === '$' && peek(1) === '{') {
        advance();
        advance();
        push(T.StringHead, out, l, c, out);
        interpolations.push(depth);
        depth++;
        return;
      }
      out += advance();
    }
    if (i >= src.length) {
      error('Unterminated string', l, c);
      return;
    }
    advance();
    push(T.String, out, l, c, out);
  }

  while (i < src.length) {
    const ch = peek();
    if (ch === '\n') {
      nl = true;
      advance();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '/' && peek(1) === '/') {
      while (i < src.length && peek() !== '\n') advance();
      continue;
    }

    const l = line;
    const c = col;
    const start = i;

    if (isDigit(ch)) {
      while (isDigit(peek()) || peek() === '_') advance();
      if (peek() === '.' && isDigit(peek(1))) {
        advance();
        while (isDigit(peek()) || peek() === '_') advance();
      }
      const text = src.slice(start, i);
      push(T.Number, text, l, c, Number(text.replaceAll('_', '')));
      continue;
    }

    if (isAlpha(ch)) {
      while (isAlpha(peek()) || isDigit(peek())) advance();
      const text = src.slice(start, i);
      push(KEYWORDS[text] ?? T.Ident, text, l, c);
      continue;
    }

    advance();
    const two = (next: string, yes: T, no: T) => {
      if (peek() === next) {
        advance();
        push(yes, src.slice(start, i), l, c);
      } else {
        push(no, ch, l, c);
      }
    };

    switch (ch) {
      case '"': string(l, c); break;
      case '(': push(T.LParen, ch, l, c); break;
      case ')': push(T.RParen, ch, l, c); break;
      case '[': push(T.LBracket, ch, l, c); break;
      case ']': push(T.RBracket, ch, l, c); break;
      case ',': push(T.Comma, ch, l, c); break;
      case ':': push(T.Colon, ch, l, c); break;
      case ';': push(T.Semicolon, ch, l, c); break;
      case '%': push(T.Percent, ch, l, c); break;
      case '{':
        depth++;
        push(T.LBrace, ch, l, c);
        break;
      case '}':
        if (interpolations.length && interpolations[interpolations.length - 1] === depth - 1) {
          interpolations.pop();
          depth--;
          string(l, c);
        } else {
          depth--;
          push(T.RBrace, ch, l, c);
        }
        break;
      case '.': two('.', T.DotDot, T.Dot); break;
      case '+': two('=', T.PlusEq, T.Plus); break;
      case '-': two('=', T.MinusEq, T.Minus); break;
      case '*': two('=', T.StarEq, T.Star); break;
      case '/': two('=', T.SlashEq, T.Slash); break;
      case '!': two('=', T.BangEq, T.Bang); break;
      case '=': two('=', T.EqEq, T.Eq); break;
      case '<': two('=', T.LtEq, T.Lt); break;
      case '>': two('=', T.GtEq, T.Gt); break;
      default:
        error(`Unexpected character '${ch}'`, l, c);
    }
  }

  push(T.EOF, '', line, col);
  return { tokens, errors };
}
