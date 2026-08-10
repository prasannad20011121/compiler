/**
 * The C/C++ type system. Struct/array/pointer sizes are computed eagerly
 * (at definition time) since our subset requires complete types wherever
 * they're used, matching ordinary single-pass C compilation.
 */

export type CTypeKind =
  | 'void' | 'bool'
  | 'char' | 'uchar' | 'schar'
  | 'short' | 'ushort'
  | 'int' | 'uint'
  | 'long' | 'ulong'      // 64-bit (we treat long == long long: WASM has no native 32-bit-long distinction worth modeling)
  | 'float' | 'double'
  | 'pointer' | 'array' | 'function' | 'struct' | 'union' | 'enum';

export interface CType {
  kind: CTypeKind;
  size: number;   // bytes; 0 for incomplete/void/function
  align: number;
  // pointer/array
  pointee?: CType;
  arrayLen?: number | null; // null = incomplete ("[]")
  // struct/union
  tag?: string;
  fields?: StructField[];
  methods?: ClassMethod[]; // C++ classes/structs only
  ctorName?: string; // mangled name of the 0-arg constructor, if any (for auto-default-construct)
  dtorName?: string; // mangled name of the destructor, if any
  // function
  params?: CType[];
  paramNames?: string[];
  returns?: CType;
  variadic?: boolean;
  // enum
  underlying?: CType;
  // cv-qualifiers (informational only; not enforced)
  isConst?: boolean;
  /** C++ references (`int&`): represented as a pointer CType with this flag set, so all the
   * existing pointer machinery (size, alignment, calling convention) applies unchanged — codegen
   * special-cases this flag purely to add the auto-deref-on-every-use behavior a plain pointer
   * doesn't have. See codegen's isReferenceLocal/emitLvalueAddr's Ident case. */
  isReference?: boolean;
}

export interface StructField {
  name: string;
  type: CType;
  offset: number;
}

/** A C++ member function, resolved to an ordinary global function taking an explicit `this` first parameter. No overloading: one entry per name. */
export interface ClassMethod {
  name: string; // unqualified method name, e.g. "distance"
  mangledName: string; // globally-unique function name, e.g. "Point__distance"
  type: CType; // function type, params[0] is always the `this` pointer
}

const cache: Record<string, CType> = {};
function prim(kind: CTypeKind, size: number, align: number): CType {
  const key = kind;
  if (!cache[key]) cache[key] = { kind, size, align };
  return cache[key];
}

export const Types = {
  void: prim('void', 0, 1),
  bool: prim('bool', 4, 4), // stored as i32 (0/1)
  char: prim('char', 1, 1),
  uchar: prim('uchar', 1, 1),
  schar: prim('schar', 1, 1),
  short: prim('short', 2, 2),
  ushort: prim('ushort', 2, 2),
  int: prim('int', 4, 4),
  uint: prim('uint', 4, 4),
  long: prim('long', 8, 8),
  ulong: prim('ulong', 8, 8),
  float: prim('float', 4, 4),
  double: prim('double', 8, 8),
};

export function pointerTo(pointee: CType): CType {
  return { kind: 'pointer', size: 4, align: 4, pointee };
}

export function referenceTo(pointee: CType): CType {
  return { kind: 'pointer', size: 4, align: 4, pointee, isReference: true };
}

export function arrayOf(elem: CType, len: number | null): CType {
  return { kind: 'array', size: len == null ? 0 : elem.size * len, align: elem.align, pointee: elem, arrayLen: len };
}

export function functionType(params: CType[], returns: CType, variadic: boolean, paramNames?: string[]): CType {
  return { kind: 'function', size: 0, align: 1, params, returns, variadic, paramNames };
}

function align(n: number, a: number): number {
  return a <= 1 ? n : Math.ceil(n / a) * a;
}

export function makeStruct(tag: string, fields: { name: string; type: CType }[], isUnion: boolean): CType {
  let offset = 0;
  let maxAlign = 1;
  const laidOut: StructField[] = [];
  for (const f of fields) {
    maxAlign = Math.max(maxAlign, f.type.align);
    if (isUnion) {
      laidOut.push({ name: f.name, type: f.type, offset: 0 });
    } else {
      offset = align(offset, f.type.align);
      laidOut.push({ name: f.name, type: f.type, offset });
      offset += f.type.size;
    }
  }
  const size = isUnion
    ? align(Math.max(1, ...fields.map((f) => f.type.size)), maxAlign)
    : align(Math.max(offset, 1), maxAlign);
  return { kind: isUnion ? 'union' : 'struct', size, align: maxAlign, tag, fields: laidOut };
}

export function isIntegerType(t: CType): boolean {
  return ['bool', 'char', 'uchar', 'schar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'enum'].includes(t.kind);
}
export function isFloatType(t: CType): boolean {
  return t.kind === 'float' || t.kind === 'double';
}
export function isArithmeticType(t: CType): boolean {
  return isIntegerType(t) || isFloatType(t);
}
export function isPointerType(t: CType): boolean {
  return t.kind === 'pointer';
}
export function isScalarType(t: CType): boolean {
  return isArithmeticType(t) || isPointerType(t);
}
export function isAggregateType(t: CType): boolean {
  return t.kind === 'struct' || t.kind === 'union' || t.kind === 'array';
}
/** True if this type is passed/returned as a WASM i64 (vs i32/f32/f64). */
export function is64BitInt(t: CType): boolean {
  return t.kind === 'long' || t.kind === 'ulong';
}
export function isUnsigned(t: CType): boolean {
  return t.kind === 'uchar' || t.kind === 'ushort' || t.kind === 'uint' || t.kind === 'ulong' || t.kind === 'bool';
}
export function isSigned(t: CType): boolean {
  return isIntegerType(t) && !isUnsigned(t);
}

export function typeEquals(a: CType, b: CType): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'pointer':
      return typeEquals(a.pointee!, b.pointee!);
    case 'array':
      return typeEquals(a.pointee!, b.pointee!);
    case 'struct':
    case 'union':
      return a.tag === b.tag;
    case 'function':
      return (
        a.params!.length === b.params!.length &&
        a.params!.every((p, i) => typeEquals(p, b.params![i])) &&
        typeEquals(a.returns!, b.returns!)
      );
    default:
      return true;
  }
}

export function typeName(t: CType): string {
  switch (t.kind) {
    case 'pointer':
      return `${typeName(t.pointee!)}*`;
    case 'array':
      return `${typeName(t.pointee!)}[${t.arrayLen ?? ''}]`;
    case 'struct':
      return `struct ${t.tag ?? '<anon>'}`;
    case 'union':
      return `union ${t.tag ?? '<anon>'}`;
    case 'function':
      return `${typeName(t.returns!)}(${t.params!.map(typeName).join(', ')})`;
    default:
      return t.kind;
  }
}
