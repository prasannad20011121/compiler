import type { CType } from './types.ts';
import {
  Types, pointerTo, isIntegerType, isFloatType, isArithmeticType, isPointerType, isScalarType,
  is64BitInt, isUnsigned, typeEquals, typeName,
} from './types.ts';
import type { Expr, Stmt, VarDecl, FunctionDecl, TopDecl } from './ast.ts';
import { ModuleBuilder, FuncBuilder } from './wasm/module.ts';
import { ValType, Op } from './wasm/opcodes.ts';
import type { ValType as VT } from './wasm/opcodes.ts';

export class CodegenError extends Error {
  constructor(message: string, pos: { file: string; line: number }) {
    super(`${pos.file}:${pos.line}: ${message}`);
  }
}

function alignUp(n: number, a: number): number {
  return a <= 1 ? n : Math.ceil(n / a) * a;
}

/** WASM value-slot kind a C value occupies on the operand stack. */
type Slot = 'i32' | 'i64' | 'f32' | 'f64';

function slotOf(t: CType): Slot {
  if (t.kind === 'float') return 'f32';
  if (t.kind === 'double') return 'f64';
  if (is64BitInt(t)) return 'i64';
  return 'i32'; // int-family, pointer, bool, struct-address, array-address
}
function valType(s: Slot): VT {
  return ValType[s];
}

interface GlobalInfo {
  isFunc: boolean;
  type: CType;
  address?: number; // memory address, for variables
  funcIndex?: number; // wasm function index, for functions
  variadic?: boolean;
}

interface LocalInfo {
  type: CType;
  offset: number; // byte offset from the frame base (current __stack_ptr after prologue)
}

interface ScratchPool {
  free: Record<Slot, number[]>;
  used: Record<Slot, number[]>;
}

const STACK_SIZE = 2 * 1024 * 1024; // 2MB shadow stack
const PAGE_SIZE = 65536;

export class CodeGenerator {
  private mod = new ModuleBuilder();
  private globals = new Map<string, GlobalInfo>();
  private dataBytes: number[] = [];
  private dataBase = 16; // keep low addresses free so 0/NULL never aliases real data
  private stackTop = 0; // set once data layout is finalized
  private spGlobal!: number;
  private heapBaseGlobal!: number;

  // per-function state, reset in compileFunction
  private locals!: Map<string, LocalInfo>[];
  private frameSize = 0;
  private fb!: FuncBuilder;
  private scratch!: ScratchPool;
  private blockDepth = 0;
  private loopStack: { continueDepth: number }[] = [];
  private breakStack: { breakDepth: number }[] = [];
  private exitBlockDepth = 0;
  private currentFn!: FunctionDecl;

  /** Registered before codegen so user code and runtime code can call each other regardless of definition order. */
  registerFunction(name: string, type: CType, isDefinition: boolean): number {
    const existing = this.globals.get(name);
    if (existing && existing.isFunc) return existing.funcIndex!;
    const paramSlots = type.params!.map((p) => valType(slotOf(p)));
    const extraVararg = type.variadic ? [ValType.i32] : [];
    const resultSlots = type.returns!.kind === 'void' ? [] : [valType(returnSlot(type.returns!))];
    const idx = this.mod.declareFunc(name, [...paramSlots, ...extraVararg], resultSlots);
    this.globals.set(name, { isFunc: true, type, funcIndex: idx, variadic: type.variadic });
    void isDefinition;
    return idx;
  }

  importFunction(module: string, name: string, exposedAs: string, type: CType): number {
    const paramSlots = type.params!.map((p) => valType(slotOf(p)));
    const resultSlots = type.returns!.kind === 'void' ? [] : [valType(returnSlot(type.returns!))];
    const idx = this.mod.importFunc(module, name, paramSlots, resultSlots);
    this.globals.set(exposedAs, { isFunc: true, type, funcIndex: idx });
    return idx;
  }

  reserveGlobal(name: string, type: CType): number {
    const addr = alignUp(this.dataBase, Math.max(type.align, 4));
    this.dataBase = addr + Math.max(type.size, 4);
    this.globals.set(name, { isFunc: false, type, address: addr });
    return addr;
  }

  addStringLiteral(text: string): number {
    const bytes = [...new TextEncoder().encode(text), 0];
    const addr = alignUp(this.dataBase, 4);
    for (let i = 0; i < bytes.length; i++) this.dataBytes[addr - 16 + i] = bytes[i];
    this.dataBase = addr + bytes.length;
    return addr;
  }

  writeInitialBytes(addr: number, bytes: number[]): void {
    for (let i = 0; i < bytes.length; i++) this.dataBytes[addr - 16 + i] = bytes[i] ?? 0;
  }

  declareGlobalVar(d: VarDecl): void {
    if (d.isExtern && !d.init) return; // reference to a global defined elsewhere; nothing to lay out
    const addr = this.reserveGlobal(d.name, d.type);
    if (d.init) this.writeInitialBytes(addr, this.constExprToBytes(d.type, d.init));
  }

  /** Serializes a compile-time-constant initializer expression to little-endian bytes for the data segment. Global initializers must be constant (no function calls, no reads of other runtime values) — this is a documented limitation vs. full C, which is otherwise rare in practice. */
  private constExprToBytes(type: CType, e: Expr): number[] {
    if (e.kind === 'InitList') {
      const out: number[] = [];
      if (type.kind === 'array') {
        const elem = type.pointee!;
        for (const item of e.items) out.push(...pad(this.constExprToBytes(elem, item), elem.size));
        while (out.length < type.size) out.push(0);
        return out;
      }
      if (type.kind === 'struct' || type.kind === 'union') {
        const bytes: number[] = new Array(type.size).fill(0);
        for (let i = 0; i < e.items.length && i < type.fields!.length; i++) {
          const f = type.fields![i];
          const fb = this.constExprToBytes(f.type, e.items[i]);
          for (let j = 0; j < fb.length; j++) bytes[f.offset + j] = fb[j];
        }
        return bytes;
      }
      return e.items.length > 0 ? this.constExprToBytes(type, e.items[0]) : new Array(type.size).fill(0);
    }
    if (type.kind === 'array' && type.pointee!.kind === 'char' && e.kind === 'StringLit') {
      const raw = [...new TextEncoder().encode(e.value), 0];
      const out = raw.slice(0, type.arrayLen ?? raw.length);
      while (out.length < (type.arrayLen ?? raw.length)) out.push(0);
      return out;
    }
    if (e.kind === 'StringLit') {
      const addr = this.addStringLiteral(e.value);
      return leBytes(BigInt(addr), 4);
    }
    if (e.kind === 'Nullptr') return leBytes(0n, 4);
    if (e.kind === 'IntLit' || e.kind === 'CharLit') {
      const v = e.kind === 'IntLit' ? e.value : BigInt(e.value);
      return this.numericBytes(type, Number(v));
    }
    if (e.kind === 'FloatLit') return this.numericBytes(type, e.value);
    if (e.kind === 'BoolLit') return this.numericBytes(type, e.value ? 1 : 0);
    if (e.kind === 'Unary' && e.op === '-') {
      const inner = this.constExprToBytes(type, e.operand);
      return this.numericBytes(type, -bytesToNumber(type, inner));
    }
    if (e.kind === 'Cast') return this.constExprToBytes(type, e.operand);
    throw new CodegenError('global initializer must be a compile-time constant', e.pos);
  }

  private numericBytes(type: CType, value: number): number[] {
    switch (type.kind) {
      case 'float': { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return [...b]; }
      case 'double': { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); return [...b]; }
      case 'long': case 'ulong': return leBytes(BigInt(Math.trunc(value)), 8);
      case 'char': case 'uchar': case 'schar': case 'bool': return leBytes(BigInt(Math.trunc(value)), 1);
      case 'short': case 'ushort': return leBytes(BigInt(Math.trunc(value)), 2);
      default: return leBytes(BigInt(Math.trunc(value)), 4);
    }
  }

  hasGlobal(name: string): boolean {
    return this.globals.has(name);
  }
  getGlobal(name: string): GlobalInfo | undefined {
    return this.globals.get(name);
  }

  /** Must run before any function body is compiled: those bodies reference the stack-pointer/heap-base globals by index via `global.get`, even though the *values* aren't known until finalizeMemoryLayout() runs afterward. */
  allocateRuntimeGlobals(): void {
    this.spGlobal = this.mod.addGlobalI32(true, 0);
    this.heapBaseGlobal = this.mod.addGlobalI32(true, 0);
    this.globals.set('__heap_base', { isFunc: false, type: Types.uint, address: -1 });
  }

  finalizeMemoryLayout(): void {
    const dataEnd = alignUp(this.dataBase, 16);
    this.stackTop = dataEnd + STACK_SIZE;
    const heapBase = this.stackTop;
    this.mod.setGlobalInit(this.spGlobal, this.stackTop);
    this.mod.setGlobalInit(this.heapBaseGlobal, heapBase);
    if (this.dataBytes.length > 0) {
      const arr = new Uint8Array(this.dataBytes.length);
      for (let i = 0; i < arr.length; i++) arr[i] = this.dataBytes[i] ?? 0;
      this.mod.addData(16, arr);
    }
    const totalBytes = heapBase + PAGE_SIZE * 4; // generous initial heap headroom
    this.mod.setMemoryMinPages(Math.ceil(totalBytes / PAGE_SIZE));
    this.mod.exportMemory('memory');
  }

  heapBaseGlobalIndex(): number {
    return this.heapBaseGlobal;
  }
  spGlobalIndex(): number {
    return this.spGlobal;
  }

  exportEntry(name: string): void {
    const g = this.globals.get(name);
    if (g && g.isFunc) this.mod.exportFunc(name, g.funcIndex!);
  }

  finishModule(): Uint8Array {
    return this.mod.finish();
  }

  // ---------------- functions ----------------

  compileFunction(fn: FunctionDecl): void {
    if (!fn.body) return;
    const g = this.globals.get(fn.name);
    if (!g || !g.isFunc) throw new CodegenError(`internal: function '${fn.name}' not registered`, fn.pos);
    this.currentFn = fn;
    this.fb = this.mod.newFuncBuilder(g.funcIndex!);
    this.locals = [new Map()];
    this.frameSize = 0;
    this.scratch = { free: { i32: [], i64: [], f32: [], f64: [] }, used: { i32: [], i64: [], f32: [], f64: [] } };
    this.blockDepth = 0;
    this.loopStack = [];
    this.breakStack = [];

    const paramOffsets: number[] = [];
    const params = fn.type.params!;
    for (let i = 0; i < params.length; i++) {
      const off = this.allocLocal(fn.paramNames[i] || `__p${i}`, params[i]);
      paramOffsets.push(off);
    }
    const varargBufParamIndex = fn.type.variadic ? params.length : -1;

    // Body bytes are built into a scratch FuncBuilder so we learn frameSize before finalizing the prologue.
    const bodyFb = new FuncBuilder(this.fb.paramTypes, this.fb.resultTypes);
    const realFb = this.fb;
    this.fb = bodyFb;

    const retSlot = fn.type.returns!.kind === 'void' ? null : returnSlot(fn.type.returns!);
    this.blockDepth = 1; // inside the synthetic exit block
    this.exitBlockDepth = 1; // matches the breakDepth/continueDepth convention: recorded post-increment
    bodyFb.block(retSlot ? valType(retSlot) : ValType.void);
    this.compileStmt(fn.body);
    // Non-void functions must produce a value for the block; if control falls off the end without
    // an explicit `return` (technically UB in C), trap rather than fail WASM validation. Void
    // functions legitimately fall through with no value, so they must NOT get this safety net.
    if (retSlot) bodyFb.op(Op.unreachable);
    bodyFb.end();
    this.blockDepth = 0;

    this.fb = realFb;
    this.frameSize = alignUp(this.frameSize, 16);

    // Copy locals declared during body codegen (scratch registers) onto the real builder.
    for (const t of bodyFb.extraLocals) realFb.addLocal(t);

    // Prologue: SP -= frameSize; store scalar params from wasm-native params into their stack slots.
    if (this.frameSize > 0) {
      realFb.globalGet(this.spGlobal).i32Const(this.frameSize).op(Op.i32_sub).globalSet(this.spGlobal);
    }
    for (let i = 0; i < params.length; i++) {
      this.emitStoreParamIntoSlot(i, params[i], paramOffsets[i]);
    }
    if (varargBufParamIndex >= 0) {
      // Store the vararg buffer pointer into a reserved local slot named "__va" for va_start().
      const off = this.allocLocal('__va', pointerTo(Types.void));
      this.emitAddrOfSlot(off);
      realFb.localGet(varargBufParamIndex);
      this.emitStore(Types.uint, 0);
    }

    realFb.code.append(bodyFb.code);

    if (this.frameSize > 0) {
      realFb.globalGet(this.spGlobal).i32Const(this.frameSize).op(Op.i32_add).globalSet(this.spGlobal);
    }
    this.mod.defineFuncBody(g.funcIndex!, realFb);
  }

  private emitStoreParamIntoSlot(paramIndex: number, type: CType, offset: number): void {
    this.emitAddrOfSlot(offset);
    this.fb.localGet(paramIndex);
    this.emitStore(type, 0);
  }

  private emitAddrOfSlot(offset: number): void {
    this.fb.globalGet(this.spGlobal);
    if (offset !== 0) this.fb.i32Const(offset).op(Op.i32_add);
  }

  // ---------------- locals / scopes ----------------

  private pushScope(): void {
    this.locals.push(new Map());
  }
  private popScope(): void {
    this.locals.pop();
  }
  private allocLocal(name: string, type: CType): number {
    const off = alignUp(this.frameSize, Math.max(type.align, 1));
    this.frameSize = off + Math.max(type.size, 1);
    this.locals[this.locals.length - 1].set(name, { type, offset: off });
    return off;
  }
  private lookupLocal(name: string): LocalInfo | undefined {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      const l = this.locals[i].get(name);
      if (l) return l;
    }
    return undefined;
  }

  private acquireScratch(slot: Slot): number {
    const pool = this.scratch.free[slot];
    const idx = pool.length > 0 ? pool.pop()! : this.fb.addLocal(valType(slot));
    this.scratch.used[slot].push(idx);
    return idx;
  }
  private releaseScratch(slot: Slot, idx: number): void {
    const used = this.scratch.used[slot];
    const i = used.lastIndexOf(idx);
    if (i >= 0) used.splice(i, 1);
    this.scratch.free[slot].push(idx);
  }

  // ---------------- statements ----------------

  private compileStmt(s: Stmt): void {
    switch (s.kind) {
      case 'Compound':
        this.pushScope();
        for (const st of s.body) this.compileStmt(st);
        this.popScope();
        return;
      case 'Empty':
        return;
      case 'ExprStmt': {
        const t = this.compileExpr(s.expr);
        if (t) this.fb.op(Op.drop);
        return;
      }
      case 'DeclStmt':
        for (const d of s.decls) this.compileLocalVarDecl(d);
        return;
      case 'If': {
        const cond = this.compileExpr(s.cond)!;
        this.coerceToBool(cond);
        this.fb.if_(ValType.void);
        this.blockDepth++;
        this.compileStmt(s.then);
        if (s.else) {
          this.fb.else_();
          this.compileStmt(s.else);
        }
        this.blockDepth--;
        this.fb.end();
        return;
      }
      case 'While': {
        this.fb.block(ValType.void); // break target
        this.blockDepth++;
        this.breakStack.push({ breakDepth: this.blockDepth });
        this.fb.loop(ValType.void);
        this.blockDepth++;
        this.loopStack.push({ continueDepth: this.blockDepth });
        const cond = this.compileExpr(s.cond)!;
        this.coerceToBool(cond);
        this.fb.op(Op.i32_eqz);
        this.fb.brIf(this.blockDepth - this.breakStack[this.breakStack.length - 1].breakDepth);
        this.compileStmt(s.body);
        this.fb.br(0);
        this.blockDepth--;
        this.fb.end(); // loop
        this.blockDepth--;
        this.fb.end(); // block
        this.loopStack.pop();
        this.breakStack.pop();
        return;
      }
      case 'DoWhile': {
        this.fb.block(ValType.void);
        this.blockDepth++;
        this.breakStack.push({ breakDepth: this.blockDepth });
        this.fb.loop(ValType.void);
        this.blockDepth++;
        this.loopStack.push({ continueDepth: this.blockDepth });
        this.compileStmt(s.body);
        const cond = this.compileExpr(s.cond)!;
        this.coerceToBool(cond);
        this.fb.brIf(0);
        this.blockDepth--;
        this.fb.end();
        this.blockDepth--;
        this.fb.end();
        this.loopStack.pop();
        this.breakStack.pop();
        return;
      }
      case 'For': {
        this.pushScope();
        if (s.init) this.compileStmt(s.init);
        this.fb.block(ValType.void);
        this.blockDepth++;
        this.breakStack.push({ breakDepth: this.blockDepth });
        this.fb.loop(ValType.void);
        this.blockDepth++;
        this.loopStack.push({ continueDepth: this.blockDepth });
        if (s.cond) {
          const cond = this.compileExpr(s.cond)!;
          this.coerceToBool(cond);
          this.fb.op(Op.i32_eqz);
          this.fb.brIf(this.blockDepth - this.breakStack[this.breakStack.length - 1].breakDepth);
        }
        this.compileStmt(s.body);
        if (s.step) {
          const t = this.compileExpr(s.step);
          if (t) this.fb.op(Op.drop);
        }
        this.fb.br(0);
        this.blockDepth--;
        this.fb.end();
        this.blockDepth--;
        this.fb.end();
        this.loopStack.pop();
        this.breakStack.pop();
        this.popScope();
        return;
      }
      case 'Break': {
        const top = this.breakStack[this.breakStack.length - 1];
        if (!top) throw new CodegenError("'break' outside loop/switch", s.pos);
        this.fb.br(this.blockDepth - top.breakDepth);
        return;
      }
      case 'Continue': {
        const top = this.loopStack[this.loopStack.length - 1];
        if (!top) throw new CodegenError("'continue' outside loop", s.pos);
        this.fb.br(this.blockDepth - top.continueDepth);
        return;
      }
      case 'Return': {
        if (s.expr) {
          const rt = this.currentFn.type.returns!;
          const t = this.compileExpr(s.expr)!;
          this.convert(t.type, rt);
        }
        this.fb.br(this.blockDepth - this.exitBlockDepth);
        return;
      }
      case 'Switch':
        this.compileSwitch(s);
        return;
      case 'Case':
      case 'Default':
        throw new CodegenError('case/default outside of a compiled switch', s.pos);
      case 'Label':
      case 'Goto':
        throw new CodegenError('goto/labels are not supported yet by this compiler', s.pos);
      default:
        throw new CodegenError(`unhandled statement kind '${(s as Stmt).kind}'`, (s as Stmt).pos);
    }
  }

  /** switch is compiled as a chain of compares + a wrapping block per case for break, using a "dispatch via nested ifs" strategy (no jump table, but correct and simple). */
  private compileSwitch(s: Extract<Stmt, { kind: 'Switch' }>): void {
    const stmts = this.flattenSwitchBody(s.body);
    const exprType = this.compileExpr(s.expr)!;
    const exprSlot = slotOf(exprType.type!);
    const scratchIdx = this.acquireScratch(exprSlot);
    this.fb.localSet(scratchIdx);

    this.fb.block(ValType.void); // break target
    this.blockDepth++;
    this.breakStack.push({ breakDepth: this.blockDepth });

    // Open one nested block per case. Blocks opened later are more deeply nested, and since we
    // process case markers in source order below (each closing the then-innermost open block),
    // the block opened LAST (innermost, depth 0 at the dispatch point) is source-order case 0,
    // and case k sits at WASM relative depth k from the dispatch point — see comment below.
    const caseCount = stmts.filter((x) => x.stmt.kind === 'Case' || x.stmt.kind === 'Default').length;
    for (let i = 0; i < caseCount; i++) this.fb.block(ValType.void);
    this.blockDepth += caseCount;

    // Dispatch: compare against each case value in order; br to the matching block depth (== caseIdx).
    let caseIdx = 0;
    let defaultIdx = -1;
    for (const item of stmts) {
      if (item.stmt.kind === 'Case') {
        this.fb.localGet(scratchIdx);
        this.pushConstOfSlot(exprSlot, this.evalCaseConst(item.stmt.expr, exprType.type!));
        this.emitCompareEq(exprSlot);
        this.fb.brIf(caseIdx);
        caseIdx++;
      } else if (item.stmt.kind === 'Default') {
        defaultIdx = caseIdx;
        caseIdx++;
      }
    }
    this.releaseScratch(exprSlot, scratchIdx);
    if (defaultIdx >= 0) {
      this.fb.br(defaultIdx);
    } else {
      this.fb.br(caseCount); // no match, no default: skip past all case-blocks to the break target
    }

    // Emit bodies in order; each `case`/`default` boundary closes one wrapping block (falls through
    // into the next case's code, matching C fallthrough semantics unless the body itself breaks).
    for (const item of stmts) {
      if (item.stmt.kind === 'Case' || item.stmt.kind === 'Default') {
        this.fb.end();
        this.blockDepth--;
      } else {
        this.compileStmt(item.stmt);
      }
    }

    this.blockDepth--;
    this.fb.end(); // break-target block
    this.breakStack.pop();
  }

  private flattenSwitchBody(body: Stmt): { stmt: Stmt }[] {
    const out: { stmt: Stmt }[] = [];
    const visit = (st: Stmt) => {
      if (st.kind === 'Compound') {
        for (const c of st.body) visit(c);
      } else {
        out.push({ stmt: st });
      }
    };
    visit(body);
    return out;
  }

  private evalCaseConst(e: Expr, targetType: CType): bigint {
    void targetType;
    if (e.kind === 'IntLit') return e.value;
    if (e.kind === 'CharLit') return BigInt(e.value);
    if (e.kind === 'Unary' && e.op === '-' && e.operand.kind === 'IntLit') return -e.operand.value;
    throw new CodegenError('case label must be a compile-time integer constant', e.pos);
  }

  private pushConstOfSlot(slot: Slot, value: bigint): void {
    if (slot === 'i64') this.fb.i64Const(value);
    else this.fb.i32Const(Number(BigInt.asIntN(32, value)));
  }
  private emitCompareEq(slot: Slot): void {
    this.fb.op(slot === 'i64' ? Op.i64_eq : Op.i32_eq);
  }

  private compileLocalVarDecl(d: VarDecl): void {
    if (d.isExtern) return; // reference to a global; no local slot
    const off = this.allocLocal(d.name, d.type);
    if (d.init) this.emitInitializer(d.type, off, d.init);
  }

  private emitInitializer(type: CType, offset: number, init: Expr): void {
    if (init.kind === 'InitList') {
      this.emitAggregateInit(type, offset, init.items);
      return;
    }
    if (type.kind === 'array' && type.pointee!.kind === 'char' && init.kind === 'StringLit') {
      const bytes = [...new TextEncoder().encode(init.value), 0];
      for (let i = 0; i < (type.arrayLen ?? bytes.length); i++) {
        this.emitAddrOfSlot(offset + i);
        this.fb.i32Const(bytes[i] ?? 0);
        this.emitStore(Types.char, 0);
      }
      return;
    }
    this.emitAddrOfSlot(offset);
    const t = this.compileExpr(init)!;
    this.convert(t.type, type);
    this.emitStore(type, 0);
  }

  private emitAggregateInit(type: CType, offset: number, items: Expr[]): void {
    if (type.kind === 'array') {
      const elem = type.pointee!;
      for (let i = 0; i < items.length; i++) this.emitInitializer(elem, offset + i * elem.size, items[i]);
      return;
    }
    if (type.kind === 'struct' || type.kind === 'union') {
      for (let i = 0; i < items.length && i < type.fields!.length; i++) {
        this.emitInitializer(type.fields![i].type, offset + type.fields![i].offset, items[i]);
      }
      return;
    }
    if (items.length > 0) this.emitInitializer(type, offset, items[0]);
  }

  // ---------------- expressions ----------------
  // Returns the C type of the value now sitting on top of the WASM operand stack, or null for void.

  private compileExpr(e: Expr): { type: CType } | null {
    switch (e.kind) {
      case 'IntLit': {
        const t = fitsInInt(e.value) ? Types.int : Types.long;
        e.type = t;
        this.pushConstOfSlot(slotOf(t), e.value);
        return { type: t };
      }
      case 'FloatLit': {
        const t = e.isFloat ? Types.float : Types.double;
        e.type = t;
        if (t.kind === 'float') this.fb.f32Const(e.value);
        else this.fb.f64Const(e.value);
        return { type: t };
      }
      case 'BoolLit':
        this.fb.i32Const(e.value ? 1 : 0);
        e.type = Types.bool;
        return { type: Types.bool };
      case 'Nullptr':
        this.fb.i32Const(0);
        e.type = pointerTo(Types.void);
        return { type: e.type };
      case 'CharLit':
        this.fb.i32Const(e.value);
        e.type = Types.char;
        return { type: Types.char };
      case 'StringLit': {
        const addr = this.addStringLiteral(e.value);
        this.fb.i32Const(addr);
        e.type = pointerTo(Types.char);
        return { type: e.type };
      }
      case 'Ident':
        return this.compileIdentLoad(e);
      case 'Assign':
        return this.compileAssign(e);
      case 'Binary':
        return this.compileBinary(e);
      case 'Unary':
        return this.compileUnary(e);
      case 'Cond':
        return this.compileCond(e);
      case 'Comma': {
        const t1 = this.compileExpr(e.left);
        if (t1) this.fb.op(Op.drop);
        return this.compileExpr(e.right);
      }
      case 'Call':
        return this.compileCall(e);
      case 'Index': {
        const { type } = this.emitLvalueAddr(e);
        this.emitLoad(type, 0);
        e.type = type;
        return { type };
      }
      case 'Member': {
        const { type } = this.emitLvalueAddr(e);
        this.emitLoad(type, 0);
        e.type = type;
        return { type };
      }
      case 'Cast': {
        const t = this.compileExpr(e.operand)!;
        this.convert(t.type, e.targetType);
        e.type = e.targetType;
        return { type: e.targetType };
      }
      case 'SizeofType':
        this.fb.i32Const(e.targetType.size);
        e.type = Types.uint;
        return { type: Types.uint };
      case 'SizeofExpr': {
        const t = this.inferType(e.operand);
        this.fb.i32Const(t.size);
        e.type = Types.uint;
        return { type: Types.uint };
      }
      case 'InitList':
        throw new CodegenError('initializer list used outside of a declaration', e.pos);
      default:
        throw new CodegenError(`expression kind '${(e as Expr).kind}' is not supported yet`, (e as Expr).pos);
    }
  }

  private compileIdentLoad(e: Extract<Expr, { kind: 'Ident' }>): { type: CType } {
    const local = this.lookupLocal(e.name);
    if (local) {
      this.emitAddrOfSlot(local.offset);
      this.emitLoad(local.type, 0);
      e.type = local.type;
      return { type: local.type };
    }
    const g = this.globals.get(e.name);
    if (g && !g.isFunc) {
      this.fb.i32Const(g.address!);
      if (g.type.kind !== 'array' && g.type.kind !== 'struct' && g.type.kind !== 'union') {
        this.emitLoad(g.type, 0);
      }
      e.type = g.type;
      return { type: g.type };
    }
    if (g && g.isFunc) {
      this.fb.i32Const(g.funcIndex!); // function value used as a pointer (address == index in our model)
      e.type = pointerTo(g.type);
      return { type: e.type };
    }
    throw new CodegenError(`use of undeclared identifier '${e.name}'`, e.pos);
  }

  private coerceToBool(t: { type: CType }): void {
    const slot = slotOf(t.type);
    if (slot === 'i32') return; // already comparable via i32.eqz/nonzero
    if (slot === 'i64') {
      this.fb.i64Const(0n).op(Op.i64_ne);
      return;
    }
    if (slot === 'f32') { this.fb.f32Const(0).op(Op.f32_ne); return; }
    this.fb.f64Const(0).op(Op.f64_ne);
  }

  // ---- lvalues: Index / Member / deref(*) / Ident(for &) ----

  private emitLvalueAddr(e: Expr): { type: CType } {
    if (e.kind === 'Ident') {
      const local = this.lookupLocal(e.name);
      if (local) {
        this.emitAddrOfSlot(local.offset);
        e.type = local.type;
        return { type: local.type };
      }
      const g = this.globals.get(e.name);
      if (g && !g.isFunc) {
        this.fb.i32Const(g.address!);
        e.type = g.type;
        return { type: g.type };
      }
      throw new CodegenError(`use of undeclared identifier '${e.name}'`, e.pos);
    }
    if (e.kind === 'Unary' && e.op === '*') {
      const t = this.compileExpr(e.operand)!;
      if (!isPointerType(t.type) && t.type.kind !== 'array') throw new CodegenError('dereferenced expression is not a pointer', e.pos);
      const pointee = t.type.pointee!;
      e.type = pointee;
      return { type: pointee };
    }
    if (e.kind === 'Index') {
      const baseT = this.inferType(e.base);
      const elem = baseT.kind === 'array' || baseT.kind === 'pointer' ? baseT.pointee! : (() => { throw new CodegenError('subscripted value is not an array or pointer', e.pos); })();
      this.emitPointerBase(e.base, baseT);
      const idx = this.compileExpr(e.index)!;
      this.promoteIndexToI32(idx.type);
      this.fb.i32Const(elem.size).op(Op.i32_mul).op(Op.i32_add);
      e.type = elem;
      return { type: elem };
    }
    if (e.kind === 'Member') {
      const baseT = e.arrow ? this.derefType(this.inferType(e.base)) : this.inferType(e.base);
      if (baseT.kind !== 'struct' && baseT.kind !== 'union') throw new CodegenError('member access on non-struct type', e.pos);
      const field = baseT.fields!.find((f) => f.name === e.field);
      if (!field) throw new CodegenError(`no member named '${e.field}' in ${typeName(baseT)}`, e.pos);
      if (e.arrow) {
        const t = this.compileExpr(e.base)!;
        void t;
      } else {
        this.emitPointerBase(e.base, baseT);
      }
      if (field.offset !== 0) this.fb.i32Const(field.offset).op(Op.i32_add);
      e.type = field.type;
      return { type: field.type };
    }
    throw new CodegenError('expression is not assignable', e.pos);
  }

  /** Emits the address of an aggregate-typed (struct/array) expression, or the pointer value if it's a pointer. */
  private emitPointerBase(e: Expr, t: CType): void {
    if (t.kind === 'array' || t.kind === 'struct' || t.kind === 'union') {
      this.emitLvalueAddr(e);
    } else {
      const r = this.compileExpr(e)!;
      void r;
    }
  }

  private promoteIndexToI32(t: CType): void {
    if (is64BitInt(t)) this.fb.op(Op.i32_wrap_i64);
  }

  private derefType(t: CType): CType {
    if (t.kind !== 'pointer' && t.kind !== 'array') throw new CodegenError(`cannot dereference non-pointer type ${typeName(t)}`, { file: '', line: 0 });
    return t.pointee!;
  }

  /** Static type inference without emitting code (used where we need a type before deciding how to emit an lvalue). */
  private inferType(e: Expr): CType {
    if (e.type) return e.type;
    switch (e.kind) {
      case 'Ident': {
        const l = this.lookupLocal(e.name);
        if (l) return l.type;
        const g = this.globals.get(e.name);
        if (g) return g.isFunc ? pointerTo(g.type) : g.type;
        throw new CodegenError(`use of undeclared identifier '${e.name}'`, e.pos);
      }
      case 'Unary':
        if (e.op === '*') return this.derefType(this.inferType(e.operand));
        if (e.op === '&') return pointerTo(this.inferType(e.operand));
        return this.inferType(e.operand);
      case 'Index': {
        const bt = this.inferType(e.base);
        return bt.pointee!;
      }
      case 'Member': {
        const bt = e.arrow ? this.derefType(this.inferType(e.base)) : this.inferType(e.base);
        const f = bt.fields!.find((f) => f.name === e.field);
        if (!f) throw new CodegenError(`no member named '${e.field}'`, e.pos);
        return f.type;
      }
      case 'Cast':
        return e.targetType;
      case 'IntLit':
        return fitsInInt(e.value) ? Types.int : Types.long;
      case 'FloatLit':
        return e.isFloat ? Types.float : Types.double;
      case 'CharLit':
        return Types.char;
      case 'StringLit':
        return pointerTo(Types.char);
      case 'Call': {
        const callee = e.callee;
        if (callee.kind === 'Ident') {
          const g = this.globals.get(callee.name);
          if (g && g.isFunc) return g.type.returns!;
        }
        return Types.int;
      }
      case 'Binary':
        return this.binaryResultType(e.op, this.inferType(e.left), this.inferType(e.right));
      case 'Assign':
        return this.inferType(e.target);
      case 'Cond':
        return this.inferType(e.then);
      default:
        return Types.int;
    }
  }

  private binaryResultType(op: string, a: CType, b: CType): CType {
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) return Types.int;
    if (isPointerType(a)) return op === '-' && isPointerType(b) ? Types.long : a;
    if (isPointerType(b)) return b;
    if (a.kind === 'double' || b.kind === 'double') return Types.double;
    if (a.kind === 'float' || b.kind === 'float') return Types.float;
    if (is64BitInt(a) || is64BitInt(b)) return isUnsigned(a) || isUnsigned(b) ? Types.ulong : Types.long;
    return isUnsigned(a) || isUnsigned(b) ? Types.uint : Types.int;
  }

  // ---- assignment ----

  private compileAssign(e: Extract<Expr, { kind: 'Assign' }>): { type: CType } {
    if (e.op === '=') {
      const { type } = this.emitLvalueAddr(e.target);
      const scratchAddr = this.acquireScratch('i32');
      this.fb.localSet(scratchAddr);
      if (isAggregateAssignTarget(type)) {
        this.compileAggregateCopy(type, () => this.fb.localGet(scratchAddr), e.value);
        this.fb.localGet(scratchAddr);
        this.emitLoad(type, 0);
        this.releaseScratch('i32', scratchAddr);
        e.type = type;
        return { type };
      }
      const v = this.compileExpr(e.value)!;
      this.convert(v.type, type);
      const valScratch = this.acquireScratch(slotOf(type));
      this.fb.localSet(valScratch);
      this.fb.localGet(scratchAddr);
      this.fb.localGet(valScratch);
      this.emitStore(type, 0);
      this.fb.localGet(valScratch);
      this.releaseScratch('i32', scratchAddr);
      this.releaseScratch(slotOf(type), valScratch);
      e.type = type;
      return { type };
    }
    // Compound assignment: target OP= value  =>  target = target BINOP value
    const binOp = e.op.slice(0, -1);
    const { type } = this.emitLvalueAddr(e.target);
    const addrScratch = this.acquireScratch('i32');
    this.fb.localSet(addrScratch);
    this.fb.localGet(addrScratch);
    this.emitLoad(type, 0);
    const rhs = this.compileExpr(e.value)!;
    this.emitBinaryOp(binOp, type, rhs.type);
    const resultType = this.binaryResultType(binOp, type, rhs.type);
    this.convert(resultType, type);
    const valScratch = this.acquireScratch(slotOf(type));
    this.fb.localTee(valScratch);
    this.fb.localGet(addrScratch);
    this.fb.localGet(valScratch);
    this.emitStore(type, 0);
    this.fb.localGet(valScratch);
    this.releaseScratch('i32', addrScratch);
    this.releaseScratch(slotOf(type), valScratch);
    e.type = type;
    return { type };
  }

  private compileAggregateCopy(type: CType, pushDestAddr: () => void, srcExpr: Expr): void {
    // memcpy-style byte copy using a simple unrolled loop of i32 loads/stores.
    pushDestAddr();
    const destScratch = this.acquireScratch('i32');
    this.fb.localSet(destScratch);
    const srcT = this.emitLvalueAddr(srcExpr);
    void srcT;
    const srcScratch = this.acquireScratch('i32');
    this.fb.localSet(srcScratch);
    let off = 0;
    while (off + 4 <= type.size) {
      this.fb.localGet(destScratch).i32Const(off).op(Op.i32_add);
      this.fb.localGet(srcScratch).i32Const(off).op(Op.i32_add);
      this.fb.mem(Op.i32_load, 2, 0);
      this.fb.mem(Op.i32_store, 2, 0);
      off += 4;
    }
    while (off < type.size) {
      this.fb.localGet(destScratch).i32Const(off).op(Op.i32_add);
      this.fb.localGet(srcScratch).i32Const(off).op(Op.i32_add);
      this.fb.mem(Op.i32_load8_u, 0, 0);
      this.fb.mem(Op.i32_store8, 0, 0);
      off += 1;
    }
    this.releaseScratch('i32', srcScratch);
    this.releaseScratch('i32', destScratch);
  }

  // ---- unary ----

  private compileUnary(e: Extract<Expr, { kind: 'Unary' }>): { type: CType } {
    if (e.op === '&') {
      const { type } = this.emitLvalueAddr(e.operand);
      e.type = pointerTo(type);
      return { type: e.type };
    }
    if (e.op === '*') {
      const { type } = this.emitLvalueAddr(e);
      this.emitLoad(type, 0);
      e.type = type;
      return { type };
    }
    if (e.op === '++' || e.op === '--') {
      const { type } = this.emitLvalueAddr(e.operand);
      const addrScratch = this.acquireScratch('i32');
      this.fb.localSet(addrScratch);
      this.fb.localGet(addrScratch);
      this.emitLoad(type, 0);
      const oldScratch = this.acquireScratch(slotOf(type));
      this.fb.localSet(oldScratch);
      this.fb.localGet(oldScratch);
      this.pushOneOfType(type);
      this.emitArith(e.op === '++' ? '+' : '-', type);
      const newScratch = this.acquireScratch(slotOf(type));
      this.fb.localSet(newScratch);
      this.fb.localGet(addrScratch);
      this.fb.localGet(newScratch);
      this.emitStore(type, 0);
      this.fb.localGet(e.prefix ? newScratch : oldScratch);
      this.releaseScratch('i32', addrScratch);
      this.releaseScratch(slotOf(type), oldScratch);
      this.releaseScratch(slotOf(type), newScratch);
      e.type = type;
      return { type };
    }
    const t = this.compileExpr(e.operand)!;
    const slot = slotOf(t.type);
    switch (e.op) {
      case '-':
        if (slot === 'f32') this.fb.op(Op.f32_neg);
        else if (slot === 'f64') this.fb.op(Op.f64_neg);
        else {
          // The operand value is already on the stack; reorder to [0, operand] via a scratch local
          // so i32.sub/i64.sub (a, b) -> a - b computes 0 - operand rather than operand - 0.
          const scratch = this.acquireScratch(slot);
          this.fb.localSet(scratch);
          if (slot === 'i64') this.fb.i64Const(0n); else this.fb.i32Const(0);
          this.fb.localGet(scratch);
          this.fb.op(slot === 'i64' ? Op.i64_sub : Op.i32_sub);
          this.releaseScratch(slot, scratch);
        }
        e.type = t.type;
        return { type: t.type };
      case '+':
        e.type = t.type;
        return { type: t.type };
      case '~':
        if (slot === 'i64') this.fb.i64Const(-1n).op(Op.i64_xor);
        else this.fb.i32Const(-1).op(Op.i32_xor);
        e.type = t.type;
        return { type: t.type };
      case '!':
        this.coerceToBool(t);
        this.fb.op(Op.i32_eqz);
        e.type = Types.int;
        return { type: Types.int };
      default:
        throw new CodegenError(`unary operator '${e.op}' not supported`, e.pos);
    }
  }

  private pushOneOfType(t: CType): void {
    if (isPointerType(t)) this.fb.i32Const(t.pointee!.size || 1);
    else if (slotOf(t) === 'i64') this.fb.i64Const(1n);
    else if (slotOf(t) === 'f32') this.fb.f32Const(1);
    else if (slotOf(t) === 'f64') this.fb.f64Const(1);
    else this.fb.i32Const(1);
  }

  // ---- binary / arithmetic with usual arithmetic conversions ----

  private compileBinary(e: Extract<Expr, { kind: 'Binary' }>): { type: CType } {
    if (e.op === '&&' || e.op === '||') {
      const l = this.compileExpr(e.left)!;
      this.coerceToBool(l);
      if (e.op === '&&') {
        this.fb.if_(ValType.i32);
        const r = this.compileExpr(e.right)!;
        this.coerceToBool(r);
        this.fb.else_();
        this.fb.i32Const(0);
        this.fb.end();
      } else {
        this.fb.i32Const(1);
        this.fb.op(Op.i32_xor); // now "is false"
        this.fb.if_(ValType.i32);
        const r = this.compileExpr(e.right)!;
        this.coerceToBool(r);
        this.fb.else_();
        this.fb.i32Const(1);
        this.fb.end();
      }
      e.type = Types.int;
      return { type: Types.int };
    }

    // Pointer arithmetic special cases.
    const lt = this.inferType(e.left);
    const rt = this.inferType(e.right);
    if ((e.op === '+' || e.op === '-') && (isPointerType(lt) || lt.kind === 'array') && isArithmeticType(rt)) {
      const l = this.compileExpr(e.left)!;
      const elemSize = lt.pointee!.size || 1;
      const r = this.compileExpr(e.right)!;
      this.promoteIndexToI32(r.type);
      this.fb.i32Const(elemSize).op(Op.i32_mul);
      this.fb.op(e.op === '+' ? Op.i32_add : Op.i32_sub);
      const resT = l.type.kind === 'array' ? pointerTo(l.type.pointee!) : l.type;
      e.type = resT;
      return { type: resT };
    }
    // `int + pointer` (pointer on the right): addition commutes, but the scaling must still
    // apply to the int operand — without this the generic arithmetic path below would add the
    // raw integer to the address instead of integer*sizeof(*ptr).
    if (e.op === '+' && isArithmeticType(lt) && (isPointerType(rt) || rt.kind === 'array')) {
      const l = this.compileExpr(e.left)!;
      this.promoteIndexToI32(l.type);
      const elemSize = rt.pointee!.size || 1;
      this.fb.i32Const(elemSize).op(Op.i32_mul);
      this.compileExpr(e.right);
      this.fb.op(Op.i32_add);
      const resT = rt.kind === 'array' ? pointerTo(rt.pointee!) : rt;
      e.type = resT;
      return { type: resT };
    }
    if (e.op === '-' && (isPointerType(lt) || lt.kind === 'array') && (isPointerType(rt) || rt.kind === 'array')) {
      this.compileExpr(e.left);
      this.compileExpr(e.right);
      this.fb.op(Op.i32_sub);
      const elemSize = lt.pointee!.size || 1;
      if (elemSize !== 1) this.fb.i32Const(elemSize).op(Op.i32_div_s);
      e.type = Types.long;
      this.fb.op(Op.i64_extend_i32_s);
      return { type: Types.long };
    }

    // For comparisons the *operands* still undergo the usual arithmetic conversions (e.g. float vs
    // int compares in double), even though the comparison's own result type is always `int`.
    const operandType = this.binaryResultType(isCompare(e.op) ? '+' : e.op, lt, rt);
    const resultType = isCompare(e.op) ? Types.int : operandType;
    const l = this.compileExpr(e.left)!;
    this.convert(l.type, operandType);
    const r = this.compileExpr(e.right)!;
    this.convert(r.type, operandType);
    this.emitArith(e.op, operandType);
    e.type = resultType;
    return { type: resultType };
  }

  private emitBinaryOp(op: string, aType: CType, bType: CType): void {
    void bType;
    this.emitArith(op, aType);
  }

  private emitArith(op: string, t: CType): void {
    const slot = slotOf(t);
    const unsigned = isUnsigned(t);
    const table: Record<Slot, Partial<Record<string, number>>> = {
      i32: {
        '+': Op.i32_add, '-': Op.i32_sub, '*': Op.i32_mul,
        '/': unsigned ? Op.i32_div_u : Op.i32_div_s, '%': unsigned ? Op.i32_rem_u : Op.i32_rem_s,
        '&': Op.i32_and, '|': Op.i32_or, '^': Op.i32_xor, '<<': Op.i32_shl,
        '>>': unsigned ? Op.i32_shr_u : Op.i32_shr_s,
        '==': Op.i32_eq, '!=': Op.i32_ne,
        '<': unsigned ? Op.i32_lt_u : Op.i32_lt_s, '>': unsigned ? Op.i32_gt_u : Op.i32_gt_s,
        '<=': unsigned ? Op.i32_le_u : Op.i32_le_s, '>=': unsigned ? Op.i32_ge_u : Op.i32_ge_s,
      },
      i64: {
        '+': Op.i64_add, '-': Op.i64_sub, '*': Op.i64_mul,
        '/': unsigned ? Op.i64_div_u : Op.i64_div_s, '%': unsigned ? Op.i64_rem_u : Op.i64_rem_s,
        '&': Op.i64_and, '|': Op.i64_or, '^': Op.i64_xor, '<<': Op.i64_shl,
        '>>': unsigned ? Op.i64_shr_u : Op.i64_shr_s,
        '==': Op.i64_eq, '!=': Op.i64_ne,
        '<': unsigned ? Op.i64_lt_u : Op.i64_lt_s, '>': unsigned ? Op.i64_gt_u : Op.i64_gt_s,
        '<=': unsigned ? Op.i64_le_u : Op.i64_le_s, '>=': unsigned ? Op.i64_ge_u : Op.i64_ge_s,
      },
      f32: {
        '+': Op.f32_add, '-': Op.f32_sub, '*': Op.f32_mul, '/': Op.f32_div,
        '==': Op.f32_eq, '!=': Op.f32_ne, '<': Op.f32_lt, '>': Op.f32_gt, '<=': Op.f32_le, '>=': Op.f32_ge,
      },
      f64: {
        '+': Op.f64_add, '-': Op.f64_sub, '*': Op.f64_mul, '/': Op.f64_div,
        '==': Op.f64_eq, '!=': Op.f64_ne, '<': Op.f64_lt, '>': Op.f64_gt, '<=': Op.f64_le, '>=': Op.f64_ge,
      },
    };
    const code = table[slot][op];
    if (code === undefined) throw new CodegenError(`operator '${op}' not valid for type ${typeName(t)}`, { file: '', line: 0 });
    this.fb.op(code);
  }

  private compileCond(e: Extract<Expr, { kind: 'Cond' }>): { type: CType } {
    const c = this.compileExpr(e.cond)!;
    this.coerceToBool(c);
    const thenType = this.inferType(e.then);
    const elseType = this.inferType(e.else);
    const resultType = isArithmeticType(thenType) && isArithmeticType(elseType) ? this.binaryResultType('+', thenType, elseType) : thenType;
    const slot = resultType.kind === 'void' ? null : valType(slotOf(resultType));
    this.fb.if_(slot ?? ValType.void);
    const t1 = this.compileExpr(e.then);
    if (t1 && resultType.kind !== 'void') this.convert(t1.type, resultType);
    this.fb.else_();
    const t2 = this.compileExpr(e.else);
    if (t2 && resultType.kind !== 'void') this.convert(t2.type, resultType);
    this.fb.end();
    e.type = resultType;
    return { type: resultType };
  }

  // ---- calls ----

  private compileCall(e: Extract<Expr, { kind: 'Call' }>): { type: CType } | null {
    if (e.callee.kind === 'Ident') {
      const special = this.tryCompileBuiltinCall(e.callee.name, e.args, e.pos);
      if (special !== undefined) return special;
    }
    if (e.callee.kind !== 'Ident') throw new CodegenError('only direct function calls are supported', e.pos);
    const g = this.globals.get(e.callee.name);
    if (!g || !g.isFunc) throw new CodegenError(`call to undeclared function '${e.callee.name}'`, e.pos);
    const fixedCount = g.type.params!.length;
    for (let i = 0; i < fixedCount; i++) {
      const a = this.compileExpr(e.args[i])!;
      this.convert(a.type, g.type.params![i]);
    }
    if (g.variadic) {
      const extra = e.args.slice(fixedCount);
      const bufSize = extra.reduce((sum, a) => sum + 8, 0);
      const bufOff = this.allocLocal(`__vaarg${e.pos.line}_${Math.random()}`, { kind: 'array', size: bufSize, align: 8, pointee: Types.long, arrayLen: extra.length });
      let off = 0;
      for (const a of extra) {
        this.emitAddrOfSlot(bufOff + off);
        const t = this.compileExpr(a)!;
        const promoted = t.type.kind === 'float' ? Types.double : is64BitInt(t.type) || t.type.kind === 'double' ? t.type : Types.int;
        this.convert(t.type, promoted);
        this.emitStore(promoted, 0);
        off += 8;
      }
      this.emitAddrOfSlot(bufOff);
    }
    e.type = g.type.returns!;
    this.fb.call(g.funcIndex!);
    return g.type.returns!.kind === 'void' ? null : { type: g.type.returns! };
  }

  private tryCompileBuiltinCall(name: string, args: Expr[], pos: { file: string; line: number }): { type: CType } | null | undefined {
    if (name === '__builtin_va_start') {
      const apAddr = this.emitLvalueAddr(args[0]);
      void apAddr;
      const scratch = this.acquireScratch('i32');
      this.fb.localSet(scratch);
      this.fb.localGet(scratch);
      const va = this.lookupLocal('__va');
      if (!va) throw new CodegenError('va_start used in a non-variadic function', pos);
      this.emitAddrOfSlot(va.offset);
      this.emitLoad(pointerTo(Types.void), 0);
      this.emitStore(Types.uint, 0);
      this.releaseScratch('i32', scratch);
      return null;
    }
    if (name === '__builtin_va_end') return null;
    if (name === '__builtin_va_arg_i32' || name === '__builtin_va_arg_i64' || name === '__builtin_va_arg_f64') {
      const apAddr = this.emitLvalueAddr(args[0]);
      void apAddr;
      const scratch = this.acquireScratch('i32');
      this.fb.localSet(scratch);
      this.fb.localGet(scratch);
      this.emitLoad(Types.uint, 0);
      const ptrScratch = this.acquireScratch('i32');
      this.fb.localTee(ptrScratch);
      const kind = name.endsWith('i32') ? Types.int : name.endsWith('i64') ? Types.long : Types.double;
      this.emitLoad(kind, 0);
      this.fb.localGet(scratch);
      this.fb.localGet(ptrScratch).i32Const(8).op(Op.i32_add);
      this.emitStore(Types.uint, 0);
      this.releaseScratch('i32', scratch);
      this.releaseScratch('i32', ptrScratch);
      return { type: kind };
    }
    return undefined;
  }

  // ---- conversions, loads, stores ----

  convert(from: CType, to: CType): void {
    if (typeEquals(from, to)) return;
    const fs = slotOf(from), ts = slotOf(to);
    if (fs === ts) return; // e.g. int<->uint, or pointer<->pointer: same wasm representation
    if (fs === 'i32' && ts === 'i64') {
      this.fb.op(isUnsigned(from) ? Op.i64_extend_i32_u : Op.i64_extend_i32_s);
    } else if (fs === 'i64' && ts === 'i32') {
      this.fb.op(Op.i32_wrap_i64);
    } else if (fs === 'i32' && ts === 'f32') {
      this.fb.op(isUnsigned(from) ? Op.f32_convert_i32_u : Op.f32_convert_i32_s);
    } else if (fs === 'i32' && ts === 'f64') {
      this.fb.op(isUnsigned(from) ? Op.f64_convert_i32_u : Op.f64_convert_i32_s);
    } else if (fs === 'i64' && ts === 'f32') {
      this.fb.op(isUnsigned(from) ? Op.f32_convert_i64_u : Op.f32_convert_i64_s);
    } else if (fs === 'i64' && ts === 'f64') {
      this.fb.op(isUnsigned(from) ? Op.f64_convert_i64_u : Op.f64_convert_i64_s);
    } else if (fs === 'f32' && ts === 'i32') {
      this.fb.op(isUnsigned(to) ? Op.i32_trunc_f32_u : Op.i32_trunc_f32_s);
    } else if (fs === 'f64' && ts === 'i32') {
      this.fb.op(isUnsigned(to) ? Op.i32_trunc_f64_u : Op.i32_trunc_f64_s);
    } else if (fs === 'f32' && ts === 'i64') {
      this.fb.op(isUnsigned(to) ? Op.i64_trunc_f32_u : Op.i64_trunc_f32_s);
    } else if (fs === 'f64' && ts === 'i64') {
      this.fb.op(isUnsigned(to) ? Op.i64_trunc_f64_u : Op.i64_trunc_f64_s);
    } else if (fs === 'f32' && ts === 'f64') {
      this.fb.op(Op.f64_promote_f32);
    } else if (fs === 'f64' && ts === 'f32') {
      this.fb.op(Op.f32_demote_f64);
    }
    // Narrowing within i32 (e.g. int -> char) needs no instruction: our load/store already
    // truncates/extends at memory boundaries, and register-width i32 arithmetic is C-legal here.
  }

  private emitLoad(t: CType, offset: number): void {
    switch (t.kind) {
      case 'char': this.fb.mem(Op.i32_load8_s, 0, offset); return;
      case 'uchar': case 'bool': this.fb.mem(Op.i32_load8_u, 0, offset); return;
      case 'schar': this.fb.mem(Op.i32_load8_s, 0, offset); return;
      case 'short': this.fb.mem(Op.i32_load16_s, 1, offset); return;
      case 'ushort': this.fb.mem(Op.i32_load16_u, 1, offset); return;
      case 'int': case 'enum': this.fb.mem(Op.i32_load, 2, offset); return;
      case 'uint': this.fb.mem(Op.i32_load, 2, offset); return;
      case 'long': case 'ulong': this.fb.mem(Op.i64_load, 3, offset); return;
      case 'float': this.fb.mem(Op.f32_load, 2, offset); return;
      case 'double': this.fb.mem(Op.f64_load, 3, offset); return;
      case 'pointer': this.fb.mem(Op.i32_load, 2, offset); return;
      case 'struct': case 'union': case 'array': return; // aggregates: the "loaded value" is its address
      default:
        throw new CodegenError(`cannot load a value of type ${typeName(t)}`, { file: '', line: 0 });
    }
  }
  private emitStore(t: CType, offset: number): void {
    switch (t.kind) {
      case 'char': case 'uchar': case 'schar': case 'bool': this.fb.mem(Op.i32_store8, 0, offset); return;
      case 'short': case 'ushort': this.fb.mem(Op.i32_store16, 1, offset); return;
      case 'int': case 'uint': case 'enum': this.fb.mem(Op.i32_store, 2, offset); return;
      case 'long': case 'ulong': this.fb.mem(Op.i64_store, 3, offset); return;
      case 'float': this.fb.mem(Op.f32_store, 2, offset); return;
      case 'double': this.fb.mem(Op.f64_store, 3, offset); return;
      case 'pointer': this.fb.mem(Op.i32_store, 2, offset); return;
      default:
        throw new CodegenError(`cannot store a value of type ${typeName(t)}`, { file: '', line: 0 });
    }
  }
}

function isAggregateAssignTarget(t: CType): boolean {
  return t.kind === 'struct' || t.kind === 'union' || t.kind === 'array';
}
function isCompare(op: string): boolean {
  return ['==', '!=', '<', '>', '<=', '>='].includes(op);
}
function fitsInInt(v: bigint): boolean {
  return v >= -2147483648n && v <= 2147483647n;
}
function returnSlot(t: CType): Slot {
  return slotOf(t);
}
function leBytes(v: bigint, size: number): number[] {
  const out: number[] = [];
  let x = BigInt.asUintN(size * 8, v);
  for (let i = 0; i < size; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}
function pad(bytes: number[], size: number): number[] {
  const out = bytes.slice(0, size);
  while (out.length < size) out.push(0);
  return out;
}
function bytesToNumber(type: CType, bytes: number[]): number {
  if (type.kind === 'float') return new DataView(new Uint8Array(bytes).buffer).getFloat32(0, true);
  if (type.kind === 'double') return new DataView(new Uint8Array(bytes).buffer).getFloat64(0, true);
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return Number(v);
}
