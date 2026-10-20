export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '..';
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=';

interface Node {
  line: number;
}

export type Expr =
  | (Node & { kind: 'num'; value: number })
  | (Node & { kind: 'str'; value: string })
  | (Node & { kind: 'interp'; parts: (string | Expr)[] })
  | (Node & { kind: 'bool'; value: boolean })
  | (Node & { kind: 'nil' })
  | (Node & { kind: 'var'; name: string })
  | (Node & { kind: 'assign'; op: AssignOp; target: AssignTarget; value: Expr })
  | (Node & { kind: 'unary'; op: '-' | '!'; operand: Expr })
  | (Node & { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr })
  | (Node & { kind: 'logical'; op: 'and' | 'or'; left: Expr; right: Expr })
  | (Node & { kind: 'call'; callee: Expr; args: Expr[] })
  | (Node & { kind: 'index'; object: Expr; index: Expr })
  | (Node & { kind: 'get'; object: Expr; name: string })
  | (Node & { kind: 'list'; items: Expr[] })
  | (Node & { kind: 'map'; entries: [Expr, Expr][] })
  | (Node & { kind: 'fn'; fn: FnNode })
  | (Node & { kind: 'this' })
  | (Node & { kind: 'super'; method: string });

export type AssignTarget = Extract<Expr, { kind: 'var' | 'index' | 'get' }>;

export interface FnNode {
  name: string;
  params: string[];
  body: Stmt[];
  line: number;
}

export type Stmt =
  | (Node & { kind: 'let'; name: string; init: Expr | null })
  | (Node & { kind: 'expr'; expr: Expr })
  | (Node & { kind: 'block'; body: Stmt[] })
  | (Node & { kind: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null })
  | (Node & { kind: 'while'; cond: Expr; body: Stmt[] })
  | (Node & { kind: 'for'; name: string; iterable: Expr; body: Stmt[] })
  | (Node & { kind: 'return'; value: Expr | null })
  | (Node & { kind: 'break' })
  | (Node & { kind: 'continue' })
  | (Node & { kind: 'fndecl'; fn: FnNode })
  | (Node & { kind: 'class'; name: string; superclass: string | null; methods: FnNode[] });
