import { ByteWriter } from './leb128';
import { SectionId, ExportKind, ImportKind, Op, ValType } from './opcodes';
import type { ValType as VT } from './opcodes';

export interface FuncType {
  params: VT[];
  results: VT[];
}

function typeKey(t: FuncType): string {
  return t.params.join(',') + '->' + t.results.join(',');
}

/** Builds the instruction stream for one function body. */
export class FuncBuilder {
  readonly code = new ByteWriter();
  /** Locals beyond the params, declared in the order they were allocated. */
  readonly extraLocals: VT[] = [];

  readonly paramTypes: VT[];
  readonly resultTypes: VT[];

  constructor(paramTypes: VT[], resultTypes: VT[]) {
    this.paramTypes = paramTypes;
    this.resultTypes = resultTypes;
  }

  addLocal(type: VT): number {
    this.extraLocals.push(type);
    return this.paramTypes.length + this.extraLocals.length - 1;
  }

  op(code: number): this {
    this.code.u8(code);
    return this;
  }

  i32Const(v: number): this {
    return this.op(Op.i32_const).sleb(v);
  }
  i64Const(v: bigint): this {
    return this.op(Op.i64_const).sleb(v);
  }
  f32Const(v: number): this {
    this.code.u8(Op.f32_const);
    this.code.f32(v);
    return this;
  }
  f64Const(v: number): this {
    this.code.u8(Op.f64_const);
    this.code.f64(v);
    return this;
  }

  sleb(v: number | bigint): this {
    this.code.sleb(v);
    return this;
  }
  uleb(v: number): this {
    this.code.uleb(v);
    return this;
  }

  localGet(i: number): this {
    return this.op(Op.local_get).uleb(i);
  }
  localSet(i: number): this {
    return this.op(Op.local_set).uleb(i);
  }
  localTee(i: number): this {
    return this.op(Op.local_tee).uleb(i);
  }
  globalGet(i: number): this {
    return this.op(Op.global_get).uleb(i);
  }
  globalSet(i: number): this {
    return this.op(Op.global_set).uleb(i);
  }

  call(funcIndex: number): this {
    return this.op(Op.call).uleb(funcIndex);
  }

  /** memarg: alignment hint (log2) then offset. We always use natural alignment. */
  mem(op: number, align: number, offset: number): this {
    this.op(op);
    this.code.uleb(align);
    this.code.uleb(offset);
    return this;
  }

  block(blockType: VT | 0x40): this {
    return this.op(Op.block).u8(blockType);
  }
  loop(blockType: VT | 0x40): this {
    return this.op(Op.loop).u8(blockType);
  }
  if_(blockType: VT | 0x40): this {
    return this.op(Op.if).u8(blockType);
  }
  else_(): this {
    return this.op(Op.else);
  }
  end(): this {
    return this.op(Op.end);
  }
  br(depth: number): this {
    return this.op(Op.br).uleb(depth);
  }
  brIf(depth: number): this {
    return this.op(Op.br_if).uleb(depth);
  }

  private u8(v: number): this {
    this.code.u8(v);
    return this;
  }

  /** Encode the final body: local-decl vector + code bytes + END. */
  finish(): Uint8Array {
    const out = new ByteWriter();
    // Group consecutive identical local types into compressed runs.
    const runs: { count: number; type: VT }[] = [];
    for (const t of this.extraLocals) {
      const last = runs[runs.length - 1];
      if (last && last.type === t) last.count++;
      else runs.push({ count: 1, type: t });
    }
    out.uleb(runs.length);
    for (const r of runs) {
      out.uleb(r.count);
      out.u8(r.type);
    }
    out.append(this.code);
    out.u8(Op.end);
    return out.finish();
  }
}

export interface ImportedFunc {
  module: string;
  name: string;
  type: FuncType;
}

export interface DataSegment {
  offset: number;
  bytes: Uint8Array;
}

export interface GlobalDef {
  type: VT;
  mutable: boolean;
  initI32: number;
}

/** Whole-module builder producing a final .wasm binary. */
export class ModuleBuilder {
  private types: FuncType[] = [];
  private typeIndex = new Map<string, number>();

  private imports: ImportedFunc[] = [];
  private funcTypeIndices: number[] = []; // for locally-defined functions, in order
  private funcBodies: (FuncBuilder | null)[] = [];
  private funcNames: string[] = [];

  private globals: GlobalDef[] = [];
  private exports: { name: string; kind: number; index: number }[] = [];
  private data: DataSegment[] = [];
  private memoryMinPages = 2;

  typeOf(params: VT[], results: VT[]): number {
    const t: FuncType = { params, results };
    const key = typeKey(t);
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = this.types.length;
    this.types.push(t);
    this.typeIndex.set(key, idx);
    return idx;
  }

  importFunc(module: string, name: string, params: VT[], results: VT[]): number {
    const typeIdx = this.typeOf(params, results);
    const idx = this.imports.length;
    this.imports.push({ module, name, type: this.types[typeIdx] });
    this.funcNames[idx] = `${module}.${name}`;
    return idx; // shares the function index space with local functions
  }

  /** Reserve a function index before its body is known (for forward/recursive calls). */
  declareFunc(name: string, params: VT[], results: VT[]): number {
    const typeIdx = this.typeOf(params, results);
    const idx = this.imports.length + this.funcTypeIndices.length;
    this.funcTypeIndices.push(typeIdx);
    this.funcBodies.push(null);
    this.funcNames[idx] = name;
    return idx;
  }

  defineFuncBody(funcIndex: number, body: FuncBuilder): void {
    const localIdx = funcIndex - this.imports.length;
    if (localIdx < 0 || localIdx >= this.funcBodies.length) {
      throw new Error(`defineFuncBody: bad index ${funcIndex}`);
    }
    this.funcBodies[localIdx] = body;
  }

  newFuncBuilder(funcIndex: number): FuncBuilder {
    const localIdx = funcIndex - this.imports.length;
    const t = this.types[this.funcTypeIndices[localIdx]];
    return new FuncBuilder(t.params, t.results);
  }

  addGlobalI32(mutable: boolean, init: number): number {
    const idx = this.globals.length;
    this.globals.push({ type: ValType.i32, mutable, initI32: init });
    return idx;
  }

  /** Patches a previously-declared global's init value once it's finally known (e.g. the stack-pointer global's initial value depends on the final data-segment size, which isn't settled until after all function bodies — which reference the global by index — have been compiled). */
  setGlobalInit(index: number, value: number): void {
    this.globals[index].initI32 = value;
  }

  setMemoryMinPages(pages: number): void {
    this.memoryMinPages = pages;
  }

  addData(offset: number, bytes: Uint8Array): void {
    this.data.push({ offset, bytes });
  }

  exportFunc(name: string, funcIndex: number): void {
    this.exports.push({ name, kind: ExportKind.func, index: funcIndex });
  }
  exportMemory(name: string): void {
    this.exports.push({ name, kind: ExportKind.mem, index: 0 });
  }

  nameOf(funcIndex: number): string {
    return this.funcNames[funcIndex] ?? `func${funcIndex}`;
  }

  finish(): Uint8Array {
    const out = new ByteWriter();
    out.bytesRaw([0x00, 0x61, 0x73, 0x6d]); // \0asm
    out.bytesRaw([0x01, 0x00, 0x00, 0x00]); // version 1

    // Section 1: Type
    {
      const s = new ByteWriter();
      s.uleb(this.types.length);
      for (const t of this.types) {
        s.u8(0x60);
        s.uleb(t.params.length);
        for (const p of t.params) s.u8(p);
        s.uleb(t.results.length);
        for (const r of t.results) s.u8(r);
      }
      this.section(out, SectionId.type, s);
    }

    // Section 2: Import
    {
      const s = new ByteWriter();
      s.uleb(this.imports.length);
      for (const im of this.imports) {
        s.name(im.module);
        s.name(im.name);
        s.u8(ImportKind.func);
        s.uleb(this.typeIndex.get(typeKey(im.type))!);
      }
      this.section(out, SectionId.import, s);
    }

    // Section 3: Function
    {
      const s = new ByteWriter();
      s.uleb(this.funcTypeIndices.length);
      for (const ti of this.funcTypeIndices) s.uleb(ti);
      this.section(out, SectionId.function, s);
    }

    // Section 5: Memory
    {
      const s = new ByteWriter();
      s.uleb(1);
      s.u8(0x00); // flags: min only
      s.uleb(this.memoryMinPages);
      this.section(out, SectionId.memory, s);
    }

    // Section 6: Global
    {
      const s = new ByteWriter();
      s.uleb(this.globals.length);
      for (const g of this.globals) {
        s.u8(g.type);
        s.u8(g.mutable ? 1 : 0);
        s.u8(Op.i32_const);
        s.sleb(g.initI32);
        s.u8(Op.end);
      }
      this.section(out, SectionId.global, s);
    }

    // Section 7: Export
    {
      const s = new ByteWriter();
      s.uleb(this.exports.length);
      for (const e of this.exports) {
        s.name(e.name);
        s.u8(e.kind);
        s.uleb(e.index);
      }
      this.section(out, SectionId.export, s);
    }

    // Section 10: Code
    {
      const s = new ByteWriter();
      s.uleb(this.funcBodies.length);
      for (let i = 0; i < this.funcBodies.length; i++) {
        const body = this.funcBodies[i];
        if (!body) {
          throw new Error(`function '${this.funcNames[this.imports.length + i]}' declared but never defined`);
        }
        s.sized(new ByteWriter().bytesRaw(body.finish()));
      }
      this.section(out, SectionId.code, s);
    }

    // Section 11: Data
    {
      const s = new ByteWriter();
      s.uleb(this.data.length);
      for (const d of this.data) {
        s.uleb(0); // memory index
        s.u8(Op.i32_const);
        s.sleb(d.offset);
        s.u8(Op.end);
        s.uleb(d.bytes.length);
        s.bytesRaw(d.bytes);
      }
      this.section(out, SectionId.data, s);
    }

    return out.finish();
  }

  private section(out: ByteWriter, id: number, contents: ByteWriter): void {
    out.u8(id);
    out.sized(contents);
  }
}
