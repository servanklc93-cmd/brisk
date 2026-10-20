import { describe, expect, it } from 'vitest';
import { T, tokenize } from '../src/lexer';

const types = (src: string) => tokenize(src).tokens.map((t) => t.type);

describe('lexer', () => {
  it('reads operators and keywords', () => {
    expect(types('let x = a..b != 3')).toEqual([T.Let, T.Ident, T.Eq, T.Ident, T.DotDot, T.Ident, T.BangEq, T.Number, T.EOF]);
    expect(types('x += 1')).toEqual([T.Ident, T.PlusEq, T.Number, T.EOF]);
  });

  it('parses numbers with underscores and decimals', () => {
    const [a, b] = tokenize('1_000_000 3.25').tokens;
    expect(a.value).toBe(1000000);
    expect(b.value).toBe(3.25);
  });

  it('does not treat a range as a decimal point', () => {
    expect(types('0..10')).toEqual([T.Number, T.DotDot, T.Number, T.EOF]);
  });

  it('marks tokens that follow a newline', () => {
    const toks = tokenize('a\n  b c').tokens;
    expect(toks.map((t) => t.nl)).toEqual([false, true, false, false]);
  });

  it('skips comments', () => {
    expect(types('a // whatever ( {\nb')).toEqual([T.Ident, T.Ident, T.EOF]);
  });

  it('handles string escapes', () => {
    expect(tokenize('"a\\n\\"b\\""').tokens[0].value).toBe('a\n"b"');
  });

  it('splits interpolated strings', () => {
    const toks = tokenize('"x=${x}, y=${ {"k": y}["k"] }!"').tokens;
    expect(toks.map((t) => t.type)).toEqual([
      T.StringHead, T.Ident,
      T.StringHead, T.LBrace, T.String, T.Colon, T.Ident, T.RBrace, T.LBracket, T.String, T.RBracket,
      T.String, T.EOF,
    ]);
    expect(toks[0].value).toBe('x=');
    expect(toks[2].value).toBe(', y=');
    expect(toks[11].value).toBe('!');
  });

  it('reports errors with positions', () => {
    const { errors } = tokenize('let a = 1\nlet b = @');
    expect(errors).toEqual([{ message: "Unexpected character '@'", line: 2, col: 9 }]);
    expect(tokenize('"never closed').errors[0].message).toBe('Unterminated string');
    // the bad character is replaced by an Error token, not dropped
    expect(types('a @ b')).toEqual([T.Ident, T.Error, T.Ident, T.EOF]);
  });
});
