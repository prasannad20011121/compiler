import type { CType } from './types';

export interface Pos {
  file: string;
  line: number;
}

// ---------- Expressions ----------

export type Expr =
  | { kind: 'IntLit'; value: bigint; type?: CType; pos: Pos }
  | { kind: 'FloatLit'; value: number; isFloat: boolean; type?: CType; pos: Pos }
  | { kind: 'StringLit'; value: string; type?: CType; pos: Pos }
  | { kind: 'CharLit'; value: number; type?: CType; pos: Pos }
  | { kind: 'Ident'; name: string; type?: CType; pos: Pos }
  | { kind: 'Binary'; op: string; left: Expr; right: Expr; type?: CType; pos: Pos }
  | { kind: 'Assign'; op: string; target: Expr; value: Expr; type?: CType; pos: Pos }
  | { kind: 'Unary'; op: string; operand: Expr; prefix: boolean; type?: CType; pos: Pos }
  | { kind: 'Cond'; cond: Expr; then: Expr; else: Expr; type?: CType; pos: Pos }
  | { kind: 'Comma'; left: Expr; right: Expr; type?: CType; pos: Pos }
  | { kind: 'Call'; callee: Expr; args: Expr[]; type?: CType; pos: Pos }
  | { kind: 'Index'; base: Expr; index: Expr; type?: CType; pos: Pos }
  | { kind: 'Member'; base: Expr; field: string; arrow: boolean; type?: CType; pos: Pos }
  | { kind: 'Cast'; targetType: CType; operand: Expr; type?: CType; pos: Pos }
  | { kind: 'SizeofType'; targetType: CType; type?: CType; pos: Pos }
  | { kind: 'SizeofExpr'; operand: Expr; type?: CType; pos: Pos }
  | { kind: 'InitList'; items: Expr[]; type?: CType; pos: Pos }
  // C++ additions (used once the C++ layer is enabled)
  | { kind: 'New'; targetType: CType; args: Expr[]; type?: CType; pos: Pos }
  | { kind: 'Delete'; operand: Expr; isArray: boolean; type?: CType; pos: Pos }
  | { kind: 'This'; type?: CType; pos: Pos }
  | { kind: 'BoolLit'; value: boolean; type?: CType; pos: Pos }
  | { kind: 'Nullptr'; type?: CType; pos: Pos };

// ---------- Statements ----------

export type Stmt =
  | { kind: 'Compound'; body: Stmt[]; pos: Pos }
  | { kind: 'ExprStmt'; expr: Expr; pos: Pos }
  | { kind: 'Empty'; pos: Pos }
  | { kind: 'If'; cond: Expr; then: Stmt; else: Stmt | null; pos: Pos }
  | { kind: 'While'; cond: Expr; body: Stmt; pos: Pos }
  | { kind: 'DoWhile'; cond: Expr; body: Stmt; pos: Pos }
  | { kind: 'For'; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt; pos: Pos }
  | { kind: 'Return'; expr: Expr | null; pos: Pos }
  | { kind: 'Break'; pos: Pos }
  | { kind: 'Continue'; pos: Pos }
  | { kind: 'Switch'; expr: Expr; body: Stmt; pos: Pos }
  | { kind: 'Case'; expr: Expr; pos: Pos }
  | { kind: 'Default'; pos: Pos }
  | { kind: 'DeclStmt'; decls: VarDecl[]; pos: Pos }
  | { kind: 'Label'; name: string; pos: Pos }
  | { kind: 'Goto'; name: string; pos: Pos };

// ---------- Declarations ----------

export interface VarDecl {
  kind: 'VarDecl';
  name: string;
  type: CType;
  init: Expr | null;
  /** C++ direct-initialization args (`ClassName obj(args);`), mutually exclusive with `init`. */
  ctorArgs?: Expr[];
  isStatic: boolean;
  isExtern: boolean;
  pos: Pos;
}

export interface FunctionDecl {
  kind: 'FunctionDecl';
  name: string;
  type: CType; // function type (params/returns/variadic)
  paramNames: string[];
  body: Stmt | null; // null = prototype only
  isStatic: boolean;
  className?: string; // set for C++ member functions
  isVirtual?: boolean;
  isCtor?: boolean;
  isDtor?: boolean;
  pos: Pos;
}

export interface StructDecl {
  kind: 'StructDecl';
  type: CType;
  pos: Pos;
}

export type TopDecl = VarDecl | FunctionDecl | StructDecl;

export interface TranslationUnit {
  decls: TopDecl[];
}
