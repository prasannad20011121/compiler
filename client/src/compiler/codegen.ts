import type { CType } from './types';
import {
  Types, pointerTo, isIntegerType, isFloatType, isArithmeticType, isPointerType, isScalarType,
  is64BitInt, isUnsigned, typeEquals, typeName,
} from './types';
import type { Expr, Stmt, VarDecl, FunctionDecl, TopDecl } from './ast';
import { ModuleBuilder, FuncBuilder } from './wasm/module';
import { ValType, Op } from './wasm/opcodes';
import type { ValType as VT } from './wasm/opcodes';

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
  /** Set for `static` locals: a fixed data-segment address, used instead of the frame-relative offset. Persists across calls and is initialized once (not on every call). */
  globalAddr?: number;
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
  private staticLocalCounter = 0;

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
  /** Set only while compiling a function that uses goto/labels (see compileGotoFunctionBody);
   * null in every other function, which is the overwhelming majority. */
  private currentGotoCtx: { labelIndex: Map<string, number>; stateOffset: number; dispatchDepth: number } | null = null;

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

  private vtableAddrs = new Map<CType, number>();

  /** A vtable is just an array of function indices in the data segment — since a "function
   * pointer" in our model already *is* its function index (see compileIndirectCall), each slot
   * doubles directly as a valid `call_indirect` table index with no extra bookkeeping. Built
   * lazily on first use (from a constructor or a virtual call site): by then every method,
   * including overrides, has already been through registerFunction and has a stable funcIndex. */
  private getOrBuildVtable(classType: CType): number {
    const cached = this.vtableAddrs.get(classType);
    if (cached !== undefined) return cached;
    const bytes: number[] = [];
    for (const m of classType.methods ?? []) {
      if (!m.isVirtual) continue;
      const g = this.globals.get(m.mangledName);
      if (!g || !g.isFunc) throw new CodegenError(`internal: virtual method '${m.mangledName}' not registered`, { file: '', line: 0 });
      bytes.push(...leBytes(BigInt(g.funcIndex!), 4));
    }
    const addr = alignUp(this.dataBase, 4);
    this.dataBase = addr + Math.max(bytes.length, 4);
    this.writeInitialBytes(addr, bytes);
    this.vtableAddrs.set(classType, addr);
    return addr;
  }

  /** Index of `name`'s slot within `classType`'s vtable — the position among virtual methods only, in declaration/inheritance order (overrides keep their base's slot, see parser's registerMethod). */
  private vtableSlotIndex(classType: CType, name: string): number {
    const idx = (classType.methods ?? []).filter((m) => m.isVirtual).findIndex((m) => m.name === name);
    if (idx < 0) throw new CodegenError(`internal: virtual method '${name}' has no vtable slot`, { file: '', line: 0 });
    return idx;
  }

  declareGlobalVar(d: VarDecl): void {
    if (d.isExtern && !d.init) return; // reference to a global defined elsewhere; nothing to lay out
    const addr = this.reserveGlobal(d.name, d.type);
    if (d.init) this.writeInitialBytes(addr, this.constExprToBytes(d.type, d.init));
  }

  /** Serializes a compile-time-constant initializer expression to little-endian bytes for the data segment. Global initializers must be constant (no function calls, no reads of other runtime values) — this is a documented limitation vs. full C, which is otherwise rare in practice. */
  private constExprToBytes(type: CType, e: Expr): number[] {
    if (e.kind === 'InitList') {
      if (type.kind === 'array') {
        const elem = type.pointee!;
        const out: number[] = new Array(type.size).fill(0);
        let idx = 0;
        for (let i = 0; i < e.items.length; i++) {
          const d = e.designators?.[i];
          if (typeof d === 'number') idx = d;
          const fb = this.constExprToBytes(elem, e.items[i]);
          for (let j = 0; j < fb.length; j++) out[idx * elem.size + j] = fb[j];
          idx++;
        }
        return out;
      }
      if (type.kind === 'struct' || type.kind === 'union') {
        const bytes: number[] = new Array(type.size).fill(0);
        let idx = 0;
        for (let i = 0; i < e.items.length; i++) {
          const d = e.designators?.[i];
          if (typeof d === 'string') {
            const fi = type.fields!.findIndex((f) => f.name === d);
            if (fi < 0) throw new CodegenError(`no member named '${d}' in ${typeName(type)}`, e.pos);
            idx = fi;
          }
          if (idx >= type.fields!.length) break;
          const f = type.fields![idx];
          const fb = this.constExprToBytes(f.type, e.items[i]);
          for (let j = 0; j < fb.length; j++) bytes[f.offset + j] = fb[j];
          idx++;
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
    this.currentGotoCtx = null;

    const paramOffsets: number[] = [];
    const params = fn.type.params!;
    for (let i = 0; i < params.length; i++) {
      const off = this.allocLocal(fn.paramNames[i] || `__p${i}`, params[i]);
      paramOffsets.push(off);
    }
    const varargBufParamIndex = fn.type.variadic ? params.length : -1;
    // Allocate (but don't yet fill) the hidden vararg-buffer-pointer slot before compiling the body:
    // va_start()/va_arg() calls inside the body need to find it via lookupLocal('__va') as they're
    // compiled. The actual store of the incoming pointer happens later, in the prologue below.
    const vaSlotOffset = varargBufParamIndex >= 0 ? this.allocLocal('__va', pointerTo(Types.void)) : -1;

    // Body bytes are built into a scratch FuncBuilder so we learn frameSize before finalizing the prologue.
    const bodyFb = new FuncBuilder(this.fb.paramTypes, this.fb.resultTypes);
    const realFb = this.fb;
    this.fb = bodyFb;

    const retSlot = fn.type.returns!.kind === 'void' ? null : returnSlot(fn.type.returns!);
    this.blockDepth = 1; // inside the synthetic exit block
    this.exitBlockDepth = 1; // matches the breakDepth/continueDepth convention: recorded post-increment
    bodyFb.block(retSlot ? valType(retSlot) : ValType.void);
    if (fn.isCtor) {
      const classType = this.currentClassType();
      if (classType?.hasVtable) this.emitVtablePtrStore(classType);
    }
    if (fn.isCtor && fn.memberInits) this.emitMemberInits(fn.memberInits);
    if (fn.body.kind === 'Compound' && this.hasGotoOrLabel(fn.body)) {
      this.compileGotoFunctionBody(fn.body);
    } else {
      this.compileStmt(fn.body);
    }
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
      // Store the incoming vararg buffer pointer into the slot reserved above, for va_start().
      this.emitAddrOfSlot(vaSlotOffset);
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
    if (type.kind === 'struct' || type.kind === 'union') {
      // Struct/union params are passed by address (the caller already produced a pointer to its
      // own copy — see how struct-typed expressions evaluate to their address). Copy those bytes
      // into this function's own local slot, giving true by-value semantics: mutating the
      // parameter here must not be visible to the caller.
      this.fb.localGet(paramIndex);
      this.emitCopyBytesFromStackAddr(offset, type.size);
      return;
    }
    this.emitAddrOfSlot(offset);
    this.fb.localGet(paramIndex);
    this.emitStore(type, 0);
  }

  private emitAddrOfSlot(offset: number): void {
    this.fb.globalGet(this.spGlobal);
    if (offset !== 0) this.fb.i32Const(offset).op(Op.i32_add);
  }

  /** Address of a local variable — a fixed data-segment address for `static` locals, otherwise the usual frame-relative stack slot. */
  private emitLocalAddr(local: LocalInfo): void {
    if (local.globalAddr !== undefined) this.fb.i32Const(local.globalAddr);
    else this.emitAddrOfSlot(local.offset);
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
        if (s.cond) {
          const cond = this.compileExpr(s.cond)!;
          this.coerceToBool(cond);
          this.fb.op(Op.i32_eqz);
          this.fb.brIf(this.blockDepth - this.breakStack[this.breakStack.length - 1].breakDepth);
        }
        // The body is wrapped in its own block so `continue` can target *this*, not the loop
        // construct: branching to the loop itself jumps back to the condition check, skipping
        // the step below — wrong for `for` (unlike while/do-while, which have no separate step).
        this.fb.block(ValType.void);
        this.blockDepth++;
        this.loopStack.push({ continueDepth: this.blockDepth });
        this.compileStmt(s.body);
        this.blockDepth--;
        this.fb.end();
        this.loopStack.pop();
        if (s.step) {
          const t = this.compileExpr(s.step);
          if (t) this.fb.op(Op.drop);
        }
        this.fb.br(0);
        this.blockDepth--;
        this.fb.end();
        this.blockDepth--;
        this.fb.end();
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
          if (rt.isReference) {
            // Returning a reference means returning the referent's address, not its value.
            this.emitLvalueAddr(s.expr);
          } else {
            const t = this.compileExpr(s.expr)!;
            this.convert(t.type, rt);
          }
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
        // Reaching this directly (rather than via compileGotoFunctionBody's chunk splitting,
        // which strips top-level labels before ever calling compileStmt on them) means the label
        // is nested inside a nested block — see assertNoLabelBelowTopLevel.
        throw new CodegenError(`label '${s.name}' must be declared at the top level of the function body (nested goto targets are not supported)`, s.pos);
      case 'Goto': {
        const ctx = this.currentGotoCtx;
        const idx = ctx?.labelIndex.get(s.name);
        if (!ctx || idx === undefined) {
          throw new CodegenError(`goto target label '${s.name}' not found (labels must be declared at the top level of the function body)`, s.pos);
        }
        this.emitAddrOfSlot(ctx.stateOffset);
        this.fb.i32Const(idx);
        this.emitStore(Types.int, 0);
        this.fb.br(this.blockDepth - ctx.dispatchDepth);
        return;
      }
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

  // ---- goto/labels ----
  // Supported subset: every label a function uses must sit directly in the function body's top
  // level (not nested inside an if/loop/switch) — a `goto`, by contrast, may appear anywhere,
  // including deep inside nested loops (the classic "multi-level break to a cleanup label"
  // pattern this is mainly for). This covers the overwhelming majority of real goto usage
  // (early-exit/cleanup, retry loops, breaking out of nested loops) without needing a general
  // relooper for arbitrary jumps into the middle of nested blocks.
  //
  // Lowering: the top-level statement list is split into chunks at each label. The whole thing is
  // wrapped in one `loop`, containing one `block` per chunk, nested so chunk `j`'s block is j
  // levels deeper than chunk 0's — branching out of block `j` lands exactly at the start of chunk
  // `j` (nothing else follows a block's `end` until the next chunk's code). A dispatch check right
  // after entering the innermost block reads a hidden `state` local and branches to the matching
  // block; state 0 falls through with no branch at all (block 0 is innermost, so nothing to skip).
  // `goto label` sets state to label's chunk index and `br`s back to the loop head, which re-runs
  // the dispatch and lands on the right chunk — working the same whether the goto is textually
  // before or after the label.

  private hasGotoOrLabel(s: Stmt): boolean {
    switch (s.kind) {
      case 'Label':
      case 'Goto':
        return true;
      case 'Compound':
        return s.body.some((c) => this.hasGotoOrLabel(c));
      case 'If':
        return this.hasGotoOrLabel(s.then) || (s.else != null && this.hasGotoOrLabel(s.else));
      case 'While':
      case 'DoWhile':
        return this.hasGotoOrLabel(s.body);
      case 'For':
        return (s.init != null && this.hasGotoOrLabel(s.init)) || this.hasGotoOrLabel(s.body);
      case 'Switch':
        return this.hasGotoOrLabel(s.body);
      default:
        return false;
    }
  }

  private assertNoLabelBelowTopLevel(s: Stmt): void {
    switch (s.kind) {
      case 'Label':
        throw new CodegenError(`label '${s.name}' must be declared at the top level of the function body (nested goto targets are not supported)`, s.pos);
      case 'Compound':
        for (const c of s.body) this.assertNoLabelBelowTopLevel(c);
        return;
      case 'If':
        this.assertNoLabelBelowTopLevel(s.then);
        if (s.else) this.assertNoLabelBelowTopLevel(s.else);
        return;
      case 'While':
      case 'DoWhile':
        this.assertNoLabelBelowTopLevel(s.body);
        return;
      case 'For':
        if (s.init) this.assertNoLabelBelowTopLevel(s.init);
        this.assertNoLabelBelowTopLevel(s.body);
        return;
      case 'Switch':
        this.assertNoLabelBelowTopLevel(s.body);
        return;
      default:
        return;
    }
  }

  private compileGotoFunctionBody(body: Extract<Stmt, { kind: 'Compound' }>): void {
    this.pushScope(); // matches the scope compileStmt's own Compound case would have pushed

    const chunks: Stmt[][] = [[]];
    const labelIndex = new Map<string, number>();
    for (const s of body.body) {
      if (s.kind === 'Label') {
        labelIndex.set(s.name, chunks.length);
        chunks.push([]);
      } else {
        this.assertNoLabelBelowTopLevel(s);
        chunks[chunks.length - 1].push(s);
      }
    }
    const k = chunks.length - 1; // number of labels found

    const stateOffset = this.allocLocal(`__goto_state_${body.pos.line}`, Types.int);
    this.emitAddrOfSlot(stateOffset);
    this.fb.i32Const(0);
    this.emitStore(Types.int, 0);

    this.fb.loop(ValType.void);
    this.blockDepth++;
    const dispatchDepth = this.blockDepth;
    const outerGotoCtx = this.currentGotoCtx;
    this.currentGotoCtx = { labelIndex, stateOffset, dispatchDepth };

    // Open k+1 nested blocks, outermost (chunk k) first, so block j's `end` is followed
    // immediately by chunk j's code.
    const blockStartDepth: number[] = new Array(k + 1);
    for (let j = k; j >= 0; j--) {
      this.fb.block(ValType.void);
      this.blockDepth++;
      blockStartDepth[j] = this.blockDepth;
    }

    const dispatchSiteDepth = this.blockDepth;
    for (let j = k; j >= 1; j--) {
      this.emitAddrOfSlot(stateOffset);
      this.emitLoad(Types.int, 0);
      this.fb.i32Const(j);
      this.fb.op(Op.i32_eq);
      this.fb.brIf(dispatchSiteDepth - blockStartDepth[j]);
    }
    // state 0 (the common case: no goto has run yet): no branch needed, straight fallthrough.

    for (let j = 0; j <= k; j++) {
      this.fb.end(); // closes block j, landing exactly at the start of chunk j
      this.blockDepth--;
      for (const stmt of chunks[j]) this.compileStmt(stmt);
    }

    this.fb.end(); // closes the loop; falling off here is normal completion, not a re-loop
    this.blockDepth--;
    this.currentGotoCtx = outerGotoCtx;
    this.popScope();
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

  /** Stores this class's vtable address into the hidden vptr slot at `this`+0. Runs at the start
   * of every constructor of a hasVtable class (user-written or the synthesized default one) so
   * every object of this type ends up with a correctly-populated vptr before anything else runs. */
  private emitVtablePtrStore(classType: CType): void {
    const thisLocal = this.lookupLocal('this');
    if (!thisLocal) return;
    this.emitLocalAddr(thisLocal);
    this.emitLoad(thisLocal.type, 0); // push `this` (the object's own address)
    this.fb.i32Const(this.getOrBuildVtable(classType));
    this.fb.mem(Op.i32_store, 2, 0);
  }

  /** Resolves a constructor's member-initializer list now that the enclosing class's field types are fully known (unlike at parse time — see parser.ts). Each entry either calls the base class's constructor (`: Base(args)`), the field's own constructor (class-typed field), or is a plain `this->field = arg;` assignment (scalar field, exactly one arg). */
  private emitMemberInits(inits: NonNullable<FunctionDecl['memberInits']>): void {
    const classType = this.currentClassType();
    if (!classType) return;
    for (const { field: fieldName, args, pos } of inits) {
      if (classType.baseType && fieldName === classType.baseType.tag) {
        const baseCtor = classType.baseType.methods?.find((mm) => mm.name === classType.baseType!.tag);
        if (baseCtor) {
          const g = this.globals.get(baseCtor.mangledName)!;
          const thisLocal = this.lookupLocal('this')!;
          this.emitLocalAddr(thisLocal);
          this.emitLoad(thisLocal.type, 0);
          if (classType.baseFieldOffset) this.fb.i32Const(classType.baseFieldOffset).op(Op.i32_add);
          for (let i = 0; i < args.length; i++) {
            this.compileArgFor(args[i], g.type.params![i + 1]);
          }
          this.fb.call(g.funcIndex!);
        }
        continue;
      }
      const field = classType.fields?.find((f) => f.name === fieldName);
      if (!field) throw new CodegenError(`no member named '${fieldName}' in ${typeName(classType)}`, pos);
      const fieldCtor = (field.type.kind === 'struct' || field.type.kind === 'union') && field.type.tag
        ? field.type.methods?.find((mm) => mm.name === field.type.tag)
        : undefined;
      if (fieldCtor) {
        const g = this.globals.get(fieldCtor.mangledName)!;
        const target: Expr = { kind: 'Member', base: { kind: 'Ident', name: 'this', pos }, field: fieldName, arrow: true, pos };
        this.emitLvalueAddr(target); // &this->field
        for (let i = 0; i < args.length; i++) {
          this.compileArgFor(args[i], g.type.params![i + 1]);
        }
        this.fb.call(g.funcIndex!);
        continue;
      }
      if (args.length !== 1) {
        throw new CodegenError(`member-initializer for scalar field '${fieldName}' must have exactly one argument`, pos);
      }
      const target: Expr = { kind: 'Member', base: { kind: 'Ident', name: 'this', pos }, field: fieldName, arrow: true, pos };
      const assign: Expr = { kind: 'Assign', op: '=', target, value: args[0], pos };
      const t = this.compileExpr(assign);
      if (t) this.fb.op(Op.drop);
    }
  }

  private compileLocalVarDecl(d: VarDecl): void {
    if (d.isExtern) return; // reference to a global; no local slot
    if (d.isStatic) {
      // A `static` local gets real global storage — initialized once (baked directly into the
      // data segment, like an ordinary global's constant initializer) rather than re-run on
      // every call — and persists its value across calls, unlike an ordinary stack-frame local.
      const uniqueName = `${this.currentFn.name}__static_${d.name}_${this.staticLocalCounter++}`;
      const addr = this.reserveGlobal(uniqueName, d.type);
      if (d.init) this.writeInitialBytes(addr, this.constExprToBytes(d.type, d.init));
      this.locals[this.locals.length - 1].set(d.name, { type: d.type, offset: 0, globalAddr: addr });
      return;
    }
    const off = this.allocLocal(d.name, d.type);
    if (d.type.isReference) {
      // Binding, not a value copy: store the referent's address, not its value.
      if (!d.init) throw new CodegenError(`reference '${d.name}' must be initialized`, d.pos);
      this.emitAddrOfSlot(off);
      this.emitLvalueAddr(d.init);
      this.emitStore(d.type, 0);
      return;
    }
    if (d.init) {
      this.emitInitializer(d.type, off, d.init);
      return;
    }
    if (d.ctorArgs) {
      // `ClassName obj(args...);` direct-initialization.
      const ctorMethod = d.type.tag ? d.type.methods?.find((mm) => mm.name === d.type.tag) : undefined;
      if (!ctorMethod) throw new CodegenError(`${typeName(d.type)} has no matching constructor`, d.pos);
      const g = this.globals.get(ctorMethod.mangledName)!;
      this.emitAddrOfSlot(off);
      for (let i = 0; i < d.ctorArgs.length; i++) {
        this.compileArgFor(d.ctorArgs[i], g.type.params![i + 1]);
      }
      this.fb.call(g.funcIndex!);
      return;
    }
    // C++: a class-typed local with no initializer auto-invokes its 0-arg constructor, if any.
    // (Destructors are NOT auto-invoked at scope exit — no RAII; see class docs/gaps.)
    if (d.type.ctorName) {
      const g = this.globals.get(d.type.ctorName)!;
      this.emitAddrOfSlot(off);
      this.fb.call(g.funcIndex!);
    }
  }

  private emitInitializer(type: CType, offset: number, init: Expr): void {
    if (init.kind === 'InitList') {
      this.emitAggregateInit(type, offset, init);
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
    if (type.kind === 'struct' || type.kind === 'union') {
      // Copy-initialize from another struct-valued expression (a variable, a function call
      // returning a struct, a dereferenced pointer, ...). Struct-typed expressions always
      // evaluate to an address (see emitLoad's aggregate case), so `compileExpr` here leaves the
      // source address on the stack; copy its bytes into this slot immediately, before anything
      // else can reuse that memory (notably: if the source was a just-returned function's local,
      // its stack frame is already freed, but not yet overwritten by a subsequent call).
      const t = this.compileExpr(init)!;
      this.emitCopyBytesFromStackAddr(offset, t.type.size);
      return;
    }
    this.emitAddrOfSlot(offset);
    const t = this.compileExpr(init)!;
    this.convert(t.type, type);
    this.emitStore(type, 0);
  }

  /** Consumes a source address left on top of the WASM stack and copies `size` bytes from it into the local slot at `destOffset`. */
  private emitCopyBytesFromStackAddr(destOffset: number, size: number): void {
    const srcScratch = this.acquireScratch('i32');
    this.fb.localSet(srcScratch);
    let off = 0;
    while (off + 4 <= size) {
      this.emitAddrOfSlot(destOffset + off);
      this.fb.localGet(srcScratch).i32Const(off).op(Op.i32_add);
      this.fb.mem(Op.i32_load, 2, 0);
      this.fb.mem(Op.i32_store, 2, 0);
      off += 4;
    }
    while (off < size) {
      this.emitAddrOfSlot(destOffset + off);
      this.fb.localGet(srcScratch).i32Const(off).op(Op.i32_add);
      this.fb.mem(Op.i32_load8_u, 0, 0);
      this.fb.mem(Op.i32_store8, 0, 0);
      off += 1;
    }
    this.releaseScratch('i32', srcScratch);
  }

  private emitAggregateInit(type: CType, offset: number, init: Extract<Expr, { kind: 'InitList' }>): void {
    const items = init.items;
    const designators = init.designators;
    if (type.kind === 'array') {
      const elem = type.pointee!;
      let idx = 0;
      for (let i = 0; i < items.length; i++) {
        const d = designators?.[i];
        if (typeof d === 'number') idx = d;
        this.emitInitializer(elem, offset + idx * elem.size, items[i]);
        idx++;
      }
      return;
    }
    if (type.kind === 'struct' || type.kind === 'union') {
      let idx = 0;
      for (let i = 0; i < items.length; i++) {
        const d = designators?.[i];
        if (typeof d === 'string') {
          const fi = type.fields!.findIndex((f) => f.name === d);
          if (fi < 0) throw new CodegenError(`no member named '${d}' in ${typeName(type)}`, init.pos);
          idx = fi;
        }
        if (idx >= type.fields!.length) break;
        this.emitInitializer(type.fields![idx].type, offset + type.fields![idx].offset, items[i]);
        idx++;
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
      case 'Call': {
        const result = this.compileCall(e);
        // A call returning a reference produces its referent's address (like any other
        // aggregate/reference-valued expression) — auto-deref to the actual value when read as
        // an ordinary rvalue. When used as an lvalue instead, emitLvalueAddr's own Call case
        // intercepts first and never reaches this auto-deref.
        if (result && result.type.isReference) {
          const pointee = result.type.pointee!;
          this.emitLoad(pointee, 0);
          e.type = pointee;
          return { type: pointee };
        }
        return result;
      }
      case 'Index': {
        const baseT = this.inferType(e.base);
        if (this.findIndexOperatorMethod(baseT)) {
          const call = this.makeOperatorCall(e.base, 'operator[]', [e.index], e.pos);
          return this.compileExpr(call)!;
        }
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
      case 'InitList': {
        // A compound literal (`(Type){...}`, parsed with `.type` already set — see parseCast) is
        // otherwise an ordinary initializer list, which only makes sense attached to a
        // declaration; used bare it has no type to initialize.
        if (!e.type) throw new CodegenError('initializer list used outside of a declaration', e.pos);
        const litType = e.type;
        const off = this.allocLocal(`__compound_lit${e.pos.line}_${Math.random()}`, litType);
        this.emitInitializer(litType, off, e);
        this.emitAddrOfSlot(off);
        this.emitLoad(litType, 0);
        return { type: litType };
      }
      case 'TempObject': {
        const classType = e.targetType;
        // A stack-resident temporary: allocate a hidden frame slot, construct into it, and
        // evaluate to its address — exactly like every other aggregate-valued expression.
        const off = this.allocLocal(`__temp${e.pos.line}_${Math.random()}`, classType);
        const ctorMethod = classType.tag ? classType.methods?.find((mm) => mm.name === classType.tag) : undefined;
        if (ctorMethod) {
          const g = this.globals.get(ctorMethod.mangledName)!;
          this.emitAddrOfSlot(off);
          for (let i = 0; i < e.args.length; i++) {
            this.compileArgFor(e.args[i], g.type.params![i + 1]);
          }
          this.fb.call(g.funcIndex!);
        }
        this.emitAddrOfSlot(off);
        e.type = classType;
        return { type: classType };
      }
      case 'New': {
        const classType = e.targetType;
        const mallocG = this.globals.get('malloc');
        if (!mallocG || !mallocG.isFunc) throw new CodegenError("'new' requires malloc from the runtime", e.pos);
        this.fb.i32Const(Math.max(classType.size, 1));
        this.fb.call(mallocG.funcIndex!);
        const ptrScratch = this.acquireScratch('i32');
        this.fb.localSet(ptrScratch);
        const ctorMethod = classType.tag ? classType.methods?.find((mm) => mm.name === classType.tag) : undefined;
        if (ctorMethod) {
          const g = this.globals.get(ctorMethod.mangledName)!;
          this.fb.localGet(ptrScratch);
          for (let i = 0; i < e.args.length; i++) {
            this.compileArgFor(e.args[i], g.type.params![i + 1]);
          }
          this.fb.call(g.funcIndex!);
        }
        this.fb.localGet(ptrScratch);
        this.releaseScratch('i32', ptrScratch);
        e.type = pointerTo(classType);
        return { type: e.type };
      }
      case 'Delete': {
        const t = this.compileExpr(e.operand)!;
        const pointeeType = t.type.pointee;
        const freeG = this.globals.get('free');
        if (pointeeType?.dtorName) {
          const ptrScratch = this.acquireScratch('i32');
          this.fb.localSet(ptrScratch);
          this.fb.localGet(ptrScratch);
          this.fb.call(this.globals.get(pointeeType.dtorName)!.funcIndex!);
          this.fb.localGet(ptrScratch);
          this.releaseScratch('i32', ptrScratch);
        }
        if (freeG && freeG.isFunc) this.fb.call(freeG.funcIndex!);
        else this.fb.op(Op.drop);
        e.type = Types.void;
        return null;
      }
      default:
        throw new CodegenError(`expression kind '${(e as Expr).kind}' is not supported yet`, (e as Expr).pos);
    }
  }

  /** Inside a C++ method, bare identifiers may refer to the current class's fields (`x` meaning `this->x`). */
  private currentClassType(): CType | null {
    if (!this.currentFn || !this.currentFn.className) return null;
    return this.currentFn.type.params![0].pointee!;
  }
  private implicitThisMember(name: string, pos: Expr['pos']): Expr | null {
    const classType = this.currentClassType();
    if (!classType || !classType.fields?.some((f) => f.name === name)) return null;
    return { kind: 'Member', base: { kind: 'Ident', name: 'this', pos }, field: name, arrow: true, pos };
  }

  private compileIdentLoad(e: Extract<Expr, { kind: 'Ident' }>): { type: CType } {
    const local = this.lookupLocal(e.name);
    if (local) {
      if (local.type.isReference) {
        // A reference variable transparently reads through to its referent: load the bound
        // address (an ordinary pointer load), then load the value at that address.
        const pointee = local.type.pointee!;
        this.emitLocalAddr(local);
        this.emitLoad(local.type, 0);
        this.emitLoad(pointee, 0);
        e.type = pointee;
        return { type: pointee };
      }
      this.emitLocalAddr(local);
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
    const implicitThis = this.implicitThisMember(e.name, e.pos);
    if (implicitThis) return this.compileExpr(implicitThis)!;
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
        if (local.type.isReference) {
          // The lvalue of a reference variable is its *referent's* address (so `r = v;` writes
          // through to whatever `r` is bound to, and `&r` gives the referent's address too — the
          // same "load the bound address" step, just without the extra value-load compileIdentLoad
          // does afterward).
          const pointee = local.type.pointee!;
          this.emitLocalAddr(local);
          this.emitLoad(local.type, 0);
          e.type = pointee;
          return { type: pointee };
        }
        this.emitLocalAddr(local);
        e.type = local.type;
        return { type: local.type };
      }
      const g = this.globals.get(e.name);
      if (g && !g.isFunc) {
        this.fb.i32Const(g.address!);
        e.type = g.type;
        return { type: g.type };
      }
      const implicitThis = this.implicitThisMember(e.name, e.pos);
      if (implicitThis) return this.emitLvalueAddr(implicitThis);
      throw new CodegenError(`use of undeclared identifier '${e.name}'`, e.pos);
    }
    if (e.kind === 'Call') {
      // Only valid as an lvalue when the call returns a reference (e.g. `int &at(int i) {...}`,
      // the classic operator[]-style pattern): the raw (un-auto-dereffed) call result is already
      // the referent's address, per compileCall/the Return-statement's reference handling.
      const result = this.compileCall(e);
      if (!result || !result.type.isReference) {
        throw new CodegenError('expression is not assignable', e.pos);
      }
      const pointee = result.type.pointee!;
      e.type = pointee;
      return { type: pointee };
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
      if (this.findIndexOperatorMethod(baseT)) {
        const call = this.makeOperatorCall(e.base, 'operator[]', [e.index], e.pos);
        return this.emitLvalueAddr(call);
      }
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
    // Fallback for an aggregate-valued expression with no lvalue case of its own above (e.g. an
    // operator-overload result nested as the base of `.field`/`[i]`, like `(a + b).x`, or an
    // array/struct compound literal, `(int[]){1,2,3}[0]`): every such expression already leaves
    // its address on the stack as its "value" (see the aggregate rule in emitLoad), so evaluating
    // it as an ordinary rvalue via compileExpr already produces the address this function is
    // supposed to return.
    const t = this.inferType(e);
    if (t.kind === 'struct' || t.kind === 'union' || t.kind === 'array') {
      this.compileExpr(e);
      e.type = t;
      return { type: t };
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
        if (l) return l.type.isReference ? l.type.pointee! : l.type;
        const g = this.globals.get(e.name);
        if (g) return g.isFunc ? pointerTo(g.type) : g.type;
        const classType = this.currentClassType();
        const field = classType?.fields?.find((f) => f.name === e.name);
        if (field) return field.type;
        throw new CodegenError(`use of undeclared identifier '${e.name}'`, e.pos);
      }
      case 'Unary': {
        if (e.op === '*') return this.derefType(this.inferType(e.operand));
        if (e.op === '&') return pointerTo(this.inferType(e.operand));
        const t = this.inferType(e.operand);
        const unaryOp = this.findUnaryOperatorMethod(e.op, t);
        if (unaryOp) return this.unwrapRef(unaryOp.type.returns!);
        return t;
      }
      case 'Index': {
        const bt = this.inferType(e.base);
        if (bt.kind === 'struct' || bt.kind === 'union') {
          const method = bt.methods?.find((mm) => mm.name === 'operator[]');
          if (method) return this.unwrapRef(method.type.returns!);
        }
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
        // A call returning a reference reads (in rvalue/inferType context) as its pointee type —
        // same auto-deref-on-read rule as everywhere else references appear.
        const unwrap = (t: CType): CType => (t.isReference ? t.pointee! : t);
        const callee = e.callee;
        if (callee.kind === 'Ident') {
          const builtinType = BUILTIN_RETURN_TYPES[callee.name];
          if (builtinType) return builtinType;
          const g = this.globals.get(callee.name);
          if (g && g.isFunc) return unwrap(g.type.returns!);
          const classType = this.currentClassType();
          const implicit = classType?.methods?.find((mm) => mm.name === callee.name);
          if (implicit) return unwrap(implicit.type.returns!);
        }
        if (callee.kind === 'Member') {
          let baseType = this.inferType(callee.base);
          if (callee.arrow) baseType = this.derefType(baseType);
          const method = baseType.methods?.find((mm) => mm.name === callee.field);
          if (method) return unwrap(method.type.returns!);
        }
        if (callee.kind === 'Ident' || callee.kind === 'Member') {
          throw new CodegenError('cannot infer the type of this call', e.pos);
        }
        // Indirect call through a function-pointer-valued expression.
        const calleeType = this.inferType(callee);
        if (calleeType.kind === 'pointer' && calleeType.pointee!.kind === 'function') return calleeType.pointee!.returns!;
        throw new CodegenError('called object is not a function or function pointer', e.pos);
      }
      case 'Binary': {
        const lt = this.inferType(e.left);
        const binOp = this.findBinaryOperatorMethod(e.op, lt);
        if (binOp) return this.unwrapRef(binOp.type.returns!);
        return this.binaryResultType(e.op, lt, this.inferType(e.right));
      }
      case 'Assign':
        return this.inferType(e.target);
      case 'Cond':
        return this.inferType(e.then);
      case 'Comma':
        return this.inferType(e.right);
      case 'SizeofType':
      case 'SizeofExpr':
        return Types.uint;
      case 'New':
        return pointerTo(e.targetType);
      case 'Delete':
        return Types.void;
      case 'BoolLit':
        return Types.bool;
      case 'Nullptr':
        return pointerTo(Types.void);
      case 'TempObject':
        return e.targetType;
      case 'InitList':
        throw new CodegenError('initializer list has no standalone type', e.pos);
      default: {
        const exhaustive: never = e;
        throw new CodegenError(`internal: inferType has no case for '${(exhaustive as Expr).kind}'`, (exhaustive as Expr).pos);
      }
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
    const operandType = this.inferType(e.operand);
    if (this.findUnaryOperatorMethod(e.op, operandType)) {
      const call = this.makeOperatorCall(e.operand, `operator${e.op}`, [], e.pos);
      return this.compileExpr(call)!;
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

  // ---- operator overloading ----
  // A user-defined `T operator+(U rhs)` (etc.) member is resolved purely by name (our "no
  // overloading" rule applies here too: one `operator+` per class), matching real C++'s implicit
  // rule that an operator naturally binds tighter than falling back to built-in arithmetic. `a op
  // b` / `-a` / `!a` / `a[i]` rewrite into an ordinary method call (`a.operator+(b)`, etc.) and
  // reuse all the normal method-call machinery — including virtual dispatch, reference-returning
  // results, and struct-by-value returns — so nothing about calling one is special-cased beyond
  // this rewrite.
  private unwrapRef(t: CType): CType {
    return t.isReference ? t.pointee! : t;
  }
  private findBinaryOperatorMethod(op: string, leftType: CType) {
    if (leftType.kind !== 'struct' && leftType.kind !== 'union') return undefined;
    return leftType.methods?.find((mm) => mm.name === `operator${op}` && mm.type.params!.length === 2);
  }
  private findUnaryOperatorMethod(op: string, operandType: CType) {
    if (operandType.kind !== 'struct' && operandType.kind !== 'union') return undefined;
    return operandType.methods?.find((mm) => mm.name === `operator${op}` && mm.type.params!.length === 1);
  }
  private findIndexOperatorMethod(baseType: CType) {
    if (baseType.kind !== 'struct' && baseType.kind !== 'union') return undefined;
    return baseType.methods?.find((mm) => mm.name === 'operator[]');
  }
  private makeOperatorCall(base: Expr, methodName: string, args: Expr[], pos: Expr['pos']): Extract<Expr, { kind: 'Call' }> {
    const callee: Extract<Expr, { kind: 'Member' }> = { kind: 'Member', base, field: methodName, arrow: false, pos };
    return { kind: 'Call', callee, args, pos };
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

    const lt = this.inferType(e.left);
    if (this.findBinaryOperatorMethod(e.op, lt)) {
      const call = this.makeOperatorCall(e.left, `operator${e.op}`, [e.right], e.pos);
      return this.compileExpr(call)!;
    }

    // Pointer arithmetic special cases.
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
    if (e.callee.kind === 'Member') return this.compileMethodCall(e, e.callee);
    // A named function called directly (not through a local variable holding a function pointer)
    // resolves to a known global by name; everything else — a local/field holding a function
    // pointer, an array/struct element, the result of another expression — is an indirect call
    // through whatever value the callee expression produces (see compileIndirectCall).
    if (e.callee.kind === 'Ident' && !this.lookupLocal(e.callee.name)) {
      const calleeName = e.callee.name;
      if (!this.globals.has(calleeName)) {
        // Inside a method, an unqualified call to another method of the same class means `this->name(...)`.
        const classType = this.currentClassType();
        if (classType?.methods?.some((mm) => mm.name === calleeName)) {
          const pos = e.pos;
          const implicitCallee: Extract<Expr, { kind: 'Member' }> = { kind: 'Member', base: { kind: 'Ident', name: 'this', pos }, field: calleeName, arrow: true, pos };
          return this.compileMethodCall(e, implicitCallee);
        }
      }
      const g = this.globals.get(calleeName);
      if (g && g.isFunc) return this.compileDirectCall(e, g);
    }
    return this.compileIndirectCall(e);
  }

  /** Pushes one call argument, honoring a reference parameter (`void f(int &x)`): the caller
   * passes the argument's address, implicitly — no `&` at the call site, matching real C++. */
  private compileArgFor(argExpr: Expr, paramType: CType): void {
    if (paramType.isReference) {
      this.emitLvalueAddr(argExpr);
      return;
    }
    const a = this.compileExpr(argExpr)!;
    this.convert(a.type, paramType);
  }

  private compileDirectCall(e: Extract<Expr, { kind: 'Call' }>, g: GlobalInfo): { type: CType } | null {
    const fixedCount = g.type.params!.length;
    for (let i = 0; i < fixedCount; i++) {
      this.compileArgFor(e.args[i], g.type.params![i]);
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

  /**
   * Calls through a function-pointer *value* (a local/field holding one, an array/struct element,
   * ...) via WASM's `call_indirect`. Every function — imported or locally defined — lives at a
   * fixed index in a single funcref table populated 1:1 with function indices (see
   * ModuleBuilder.finish's element section), which is exactly what makes this work: a "function
   * pointer" in our model already *is* its function index (see compileIdentLoad's function
   * branch), so that index doubles as a valid table index with no extra bookkeeping.
   * No variadic support here — indirect calls to variadic functions are a rare combination and a
   * documented gap.
   */
  private compileIndirectCall(e: Extract<Expr, { kind: 'Call' }>): { type: CType } | null {
    const calleeType = this.inferType(e.callee);
    if (calleeType.kind !== 'pointer' || calleeType.pointee!.kind !== 'function') {
      throw new CodegenError('called object is not a function or function pointer', e.pos);
    }
    const fnType = calleeType.pointee!;
    const fixedCount = fnType.params!.length;
    for (let i = 0; i < fixedCount; i++) {
      this.compileArgFor(e.args[i], fnType.params![i]);
    }
    this.compileExpr(e.callee); // pushes the function index last, as call_indirect requires
    const paramSlots = fnType.params!.map((p) => valType(slotOf(p)));
    const resultSlots = fnType.returns!.kind === 'void' ? [] : [valType(slotOf(fnType.returns!))];
    const typeIdx = this.mod.typeOf(paramSlots, resultSlots);
    this.fb.callIndirect(typeIdx);
    e.type = fnType.returns!;
    return fnType.returns!.kind === 'void' ? null : { type: fnType.returns! };
  }

  /** `obj.method(args)` / `ptr->method(args)`: resolved to a call to the mangled global function
   * (inherited methods are found directly since `methods` is already flattened — see parser's
   * registerMethod), with `this` passed as an implicit first argument. No overloading, so lookup
   * is by name only. A `virtual` method dispatches through the callee's own vtable instead of
   * calling the statically-resolved function directly, so overrides in a more-derived runtime
   * type take effect even when called through a base-typed pointer/reference. */
  private compileMethodCall(e: Extract<Expr, { kind: 'Call' }>, m: Extract<Expr, { kind: 'Member' }>): { type: CType } | null {
    let baseType = this.inferType(m.base);
    if (m.arrow) baseType = this.derefType(baseType);
    if (baseType.kind !== 'struct' && baseType.kind !== 'union') {
      throw new CodegenError(`member function call on non-class type ${typeName(baseType)}`, e.pos);
    }
    const method = baseType.methods?.find((mm) => mm.name === m.field);
    if (!method) throw new CodegenError(`no member function named '${m.field}' in ${typeName(baseType)}`, e.pos);
    const g = this.globals.get(method.mangledName);
    if (!g || !g.isFunc) throw new CodegenError(`internal: method '${method.mangledName}' not registered`, e.pos);

    if (method.isVirtual) {
      const thisScratch = this.acquireScratch('i32');
      if (m.arrow) this.compileExpr(m.base); else this.emitLvalueAddr(m.base);
      this.fb.localSet(thisScratch);
      this.fb.localGet(thisScratch); // `this`, as the call's implicit first argument
      for (let i = 0; i < e.args.length; i++) {
        this.compileArgFor(e.args[i], g.type.params![i + 1]);
      }
      this.fb.localGet(thisScratch);
      this.fb.mem(Op.i32_load, 2, 0); // vptr = *(this + 0)
      this.fb.mem(Op.i32_load, 2, this.vtableSlotIndex(baseType, method.name) * 4); // funcIndex = vptr[slot]
      this.releaseScratch('i32', thisScratch);
      const paramSlots = g.type.params!.map((p) => valType(slotOf(p)));
      const resultSlots = g.type.returns!.kind === 'void' ? [] : [valType(slotOf(g.type.returns!))];
      this.fb.callIndirect(this.mod.typeOf(paramSlots, resultSlots));
      e.type = g.type.returns!;
      return g.type.returns!.kind === 'void' ? null : { type: g.type.returns! };
    }

    if (m.arrow) this.compileExpr(m.base); // already a pointer value = `this`
    else this.emitLvalueAddr(m.base); // `.` on an lvalue: `this` is its address

    for (let i = 0; i < e.args.length; i++) {
      this.compileArgFor(e.args[i], g.type.params![i + 1]);
    }
    this.fb.call(g.funcIndex!);
    e.type = g.type.returns!;
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
    if (name === '__builtin_heap_base') {
      this.fb.globalGet(this.heapBaseGlobal);
      return { type: Types.uint };
    }
    if (name === '__builtin_memory_grow') {
      const t = this.compileExpr(args[0])!;
      this.convert(t.type, Types.uint);
      this.fb.op(Op.memory_grow);
      this.fb.op(0x00); // reserved memory-index byte
      return { type: Types.int };
    }
    if (name === '__builtin_memory_size') {
      this.fb.op(Op.memory_size);
      this.fb.op(0x00); // reserved memory-index byte
      return { type: Types.int };
    }
    if (name === '__builtin_trap') {
      this.fb.op(Op.unreachable);
      return null;
    }
    if (name === '__builtin_sqrt' || name === '__builtin_fabs') {
      // Native WASM instructions (math.h's sqrt/fabs are thin C wrappers around these — see
      // runtime/libc.ts — rather than software implementations, unlike the transcendental
      // functions below which have no WASM opcode and are real algorithms in C).
      const t = this.compileExpr(args[0])!;
      this.convert(t.type, Types.double);
      this.fb.op(name === '__builtin_sqrt' ? Op.f64_sqrt : Op.f64_abs);
      return { type: Types.double };
    }
    return undefined;
  }

  // ---- conversions, loads, stores ----

  convert(from: CType, to: CType): void {
    if (typeEquals(from, to)) return;
    const fs = slotOf(from), ts = slotOf(to);
    if (fs === 'i32' && ts === 'i32') {
      // Same WASM slot, but narrower C types keep their bit pattern in the low bits of the i32
      // register between memory round-trips. A cast/assignment across differently-signed or
      // differently-sized 8/16-bit types must re-mask/re-sign-extend here, since e.g. a `char`
      // value already sign-extended to a negative i32 must become a small positive value when
      // cast to `unsigned char` (and vice versa for widening a raw byte to signed `char`).
      switch (to.kind) {
        case 'uchar': case 'bool': this.fb.i32Const(0xff).op(Op.i32_and); break;
        case 'char': case 'schar': this.fb.op(Op.i32_extend8_s); break;
        case 'ushort': this.fb.i32Const(0xffff).op(Op.i32_and); break;
        case 'short': this.fb.op(Op.i32_extend16_s); break;
        default: break; // int/uint/pointer/enum: bit pattern is already correct
      }
      return;
    }
    if (fs === ts) return; // e.g. long<->ulong, or pointer<->pointer: same wasm representation
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

/** Return types of the value-producing codegen intrinsics (see tryCompileBuiltinCall), for inferType — these never appear in this.globals since they're intercepted before an ordinary global lookup. */
const BUILTIN_RETURN_TYPES: Record<string, CType> = {
  __builtin_va_arg_i32: Types.int,
  __builtin_va_arg_i64: Types.long,
  __builtin_va_arg_f64: Types.double,
  __builtin_heap_base: Types.uint,
  __builtin_memory_grow: Types.int,
  __builtin_memory_size: Types.int,
  __builtin_sqrt: Types.double,
  __builtin_fabs: Types.double,
};

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
function bytesToNumber(type: CType, bytes: number[]): number {
  if (type.kind === 'float') return new DataView(new Uint8Array(bytes).buffer).getFloat32(0, true);
  if (type.kind === 'double') return new DataView(new Uint8Array(bytes).buffer).getFloat64(0, true);
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return Number(v);
}
