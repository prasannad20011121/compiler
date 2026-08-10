import type { Token } from './lexer';
import type { CType } from './types';
import { Types, pointerTo, referenceTo, arrayOf, functionType, makeStruct, is64BitInt, isFloatType } from './types';
import type { Expr, Stmt, VarDecl, FunctionDecl, TopDecl, Pos } from './ast';

export class ParseError extends Error {
  constructor(message: string, tok: Token) {
    super(`${tok.file}:${tok.line}:${tok.col}: ${message} (near '${tok.text || '<eof>'}')`);
  }
}

const TYPE_KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'bool',
]);
const QUALIFIER_KEYWORDS = new Set(['const', 'volatile', 'restrict', 'inline', '_Noreturn']);
const STORAGE_KEYWORDS = new Set(['typedef', 'static', 'extern', 'register', 'auto']);

interface DeclSpec {
  type: CType;
  isTypedef: boolean;
  isStatic: boolean;
  isExtern: boolean;
}

export class Parser {
  private toks: Token[];
  private pos = 0;
  private typedefScopes: Set<string>[] = [new Set()];
  private tags = new Map<string, CType>();
  private enumConsts = new Map<string, bigint>();
  /** Member function definitions found while parsing a class/struct body (C++ mode), drained into the top-level decl list after the enclosing declaration finishes. */
  private pendingMethodDecls: FunctionDecl[] = [];
  cpp: boolean;

  constructor(tokens: Token[], cpp = false) {
    this.toks = tokens;
    this.cpp = cpp;
    if (cpp) this.typedefScopes[0].add('bool');
  }

  // ---------- token helpers ----------

  private peek(o = 0): Token {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  private cur(): Token {
    return this.peek();
  }
  private advance(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  private atEof(): boolean {
    return this.cur().kind === 'eof';
  }
  private isPunct(text: string, o = 0): boolean {
    const t = this.peek(o);
    return t.kind === 'punct' && t.text === text;
  }
  private isKw(text: string, o = 0): boolean {
    const t = this.peek(o);
    return t.kind === 'ident' && t.text === text;
  }
  private eatPunct(text: string): boolean {
    if (this.isPunct(text)) {
      this.advance();
      return true;
    }
    return false;
  }
  private eatKw(text: string): boolean {
    if (this.isKw(text)) {
      this.advance();
      return true;
    }
    return false;
  }
  private expectPunct(text: string): Token {
    if (!this.isPunct(text)) throw new ParseError(`expected '${text}'`, this.cur());
    return this.advance();
  }
  private expectIdent(): string {
    const t = this.cur();
    if (t.kind !== 'ident') throw new ParseError('expected identifier', t);
    this.advance();
    return t.text;
  }
  private pos_(): Pos {
    const t = this.cur();
    return { file: t.file, line: t.line };
  }

  private isTypeName(name: string): boolean {
    for (let i = this.typedefScopes.length - 1; i >= 0; i--) {
      if (this.typedefScopes[i].has(name)) return true;
    }
    return false;
  }

  private pushScope(): void {
    this.typedefScopes.push(new Set());
  }
  private popScope(): void {
    this.typedefScopes.pop();
  }

  private startsDeclSpec(o = 0): boolean {
    const t = this.peek(o);
    if (t.kind !== 'ident') return false;
    if (TYPE_KEYWORDS.has(t.text) || QUALIFIER_KEYWORDS.has(t.text) || STORAGE_KEYWORDS.has(t.text)) return true;
    if (t.text === 'struct' || t.text === 'union' || t.text === 'enum') return true;
    if (this.cpp && t.text === 'class') return true;
    return this.isTypeName(t.text);
  }

  // ---------- translation unit ----------

  parseTranslationUnit(): TopDecl[] {
    const decls: TopDecl[] = [];
    while (!this.atEof()) {
      const d = this.parseExternalDeclaration();
      decls.push(...d);
    }
    return decls;
  }

  private parseExternalDeclaration(): TopDecl[] {
    const out = this.parseExternalDeclarationInner();
    if (this.pendingMethodDecls.length > 0) {
      out.push(...this.pendingMethodDecls);
      this.pendingMethodDecls = [];
    }
    return out;
  }

  private parseExternalDeclarationInner(): TopDecl[] {
    const spec = this.parseDeclSpecifiers();

    // `struct Foo { ... };` with no declarator at all.
    if (this.isPunct(';')) {
      this.advance();
      return [];
    }

    const first = this.parseDeclarator(spec.type);
    if (spec.isTypedef) {
      if (first.name) {
        this.typedefScopes[this.typedefScopes.length - 1].add(first.name);
        this.registerTypedef(first.name, first.type);
      }
      this.finishSimpleDeclList(spec, first);
      return [];
    }

    if (first.type.kind === 'function' && this.isPunct('{')) {
      const fn = this.parseFunctionBody(spec, first.name!, first.type);
      return [fn];
    }

    // One or more comma-separated declarators, each with optional initializer.
    // A function-typed declarator with no body here is a prototype (`int f(int);`) — still a
    // FunctionDecl (body: null), not a VarDecl, so cross-file calls can resolve against it.
    const out: TopDecl[] = [];
    let cur: { name: string | null; type: CType } | null = first;
    while (cur) {
      if (!cur.name) throw new ParseError('declarator requires a name', this.cur());
      if (cur.type.kind === 'function') {
        out.push({
          kind: 'FunctionDecl', name: cur.name, type: cur.type, paramNames: cur.type.paramNames ?? [],
          body: null, isStatic: spec.isStatic, pos: this.pos_(),
        });
        if (!this.eatPunct(',')) break;
        cur = this.parseDeclarator(spec.type);
        continue;
      }
      let init: Expr | null = null;
      if (this.eatPunct('=')) init = this.parseInitializer();
      out.push({
        kind: 'VarDecl',
        name: cur.name,
        type: this.resolveIncompleteArraySize(cur.type, init),
        init,
        isStatic: spec.isStatic,
        isExtern: spec.isExtern,
        pos: this.pos_(),
      });
      if (this.eatPunct(',')) {
        cur = this.parseDeclarator(spec.type);
      } else {
        cur = null;
      }
    }
    this.expectPunct(';');
    return out;
  }

  private finishSimpleDeclList(spec: DeclSpec, first: { name: string | null; type: CType }): void {
    let cur: { name: string | null; type: CType } | null = first;
    while (cur) {
      if (this.eatPunct(',')) {
        cur = this.parseDeclarator(spec.type);
        if (cur.name) {
          this.typedefScopes[this.typedefScopes.length - 1].add(cur.name);
          this.registerTypedef(cur.name, cur.type);
        }
      } else {
        cur = null;
      }
    }
    this.expectPunct(';');
  }

  private parseFunctionBody(spec: DeclSpec, name: string, type: CType): FunctionDecl {
    const body = this.parseCompound();
    return {
      kind: 'FunctionDecl',
      name,
      type,
      paramNames: type.paramNames ?? [],
      body,
      isStatic: spec.isStatic,
      pos: this.pos_(),
    };
  }

  // ---------- declaration specifiers ----------

  /** `char buf[] = "literal";` / `int a[] = {1,2,3};`: the array type is incomplete (arrayLen
   * null, size 0) until its initializer's length is known. Without this, such a declaration
   * would allocate zero bytes of storage and the initializer would silently overrun into
   * whatever memory follows. */
  private resolveIncompleteArraySize(type: CType, init: Expr | null): CType {
    if (type.kind !== 'array' || type.arrayLen !== null || !init) return type;
    if (init.kind === 'StringLit') return arrayOf(type.pointee!, new TextEncoder().encode(init.value).length + 1);
    if (init.kind === 'InitList') return arrayOf(type.pointee!, init.items.length);
    return type;
  }

  private parseDeclSpecifiers(): DeclSpec {
    let isTypedef = false, isStatic = false, isExtern = false;
    let voidC = 0, charC = 0, shortC = 0, intC = 0, longC = 0, floatC = 0, doubleC = 0, boolC = 0;
    let signedC = 0, unsignedC = 0;
    let resolved: CType | null = null;

    for (;;) {
      const t = this.cur();
      if (t.kind !== 'ident') break;
      if (t.text === 'typedef') { isTypedef = true; this.advance(); continue; }
      if (t.text === 'static') { isStatic = true; this.advance(); continue; }
      if (t.text === 'extern') { isExtern = true; this.advance(); continue; }
      if (STORAGE_KEYWORDS.has(t.text)) { this.advance(); continue; }
      if (QUALIFIER_KEYWORDS.has(t.text)) { this.advance(); continue; }

      if (t.text === 'struct' || t.text === 'union' || (this.cpp && t.text === 'class')) {
        resolved = this.parseStructOrUnionSpecifier(t.text === 'union', t.text === 'class');
        continue;
      }
      if (t.text === 'enum') {
        resolved = this.parseEnumSpecifier();
        continue;
      }
      if (t.text === 'void') { voidC++; this.advance(); continue; }
      if (t.text === 'char') { charC++; this.advance(); continue; }
      if (t.text === 'short') { shortC++; this.advance(); continue; }
      if (t.text === 'int') { intC++; this.advance(); continue; }
      if (t.text === 'long') { longC++; this.advance(); continue; }
      if (t.text === 'float') { floatC++; this.advance(); continue; }
      if (t.text === 'double') { doubleC++; this.advance(); continue; }
      if (t.text === 'signed') { signedC++; this.advance(); continue; }
      if (t.text === 'unsigned') { unsignedC++; this.advance(); continue; }
      if (t.text === '_Bool' || (this.cpp && t.text === 'bool')) { boolC++; this.advance(); continue; }

      if (resolved === null && voidC + charC + shortC + intC + longC + floatC + doubleC + boolC + signedC + unsignedC === 0 && this.isTypeName(t.text)) {
        resolved = this.lookupTypedef(t.text);
        this.advance();
        continue;
      }
      break;
    }

    if (resolved) return { type: resolved, isTypedef, isStatic, isExtern };

    let type: CType;
    if (boolC) type = Types.bool;
    else if (floatC) type = Types.float;
    else if (doubleC) type = Types.double;
    else if (charC) type = unsignedC ? Types.uchar : signedC ? Types.schar : Types.char;
    else if (shortC) type = unsignedC ? Types.ushort : Types.short;
    else if (longC) type = unsignedC ? Types.ulong : Types.long;
    else if (voidC) type = Types.void;
    else if (intC || signedC || unsignedC) type = unsignedC ? Types.uint : Types.int;
    else throw new ParseError('expected a type specifier', this.cur());

    return { type, isTypedef, isStatic, isExtern };
  }

  private typedefTable = new Map<string, CType>();
  private lookupTypedef(name: string): CType {
    const t = this.typedefTable.get(name);
    if (!t) throw new ParseError(`unknown type name '${name}'`, this.cur());
    return t;
  }
  registerTypedef(name: string, type: CType): void {
    this.typedefTable.set(name, type);
  }

  private parseStructOrUnionSpecifier(isUnion: boolean, isClass = false): CType {
    this.advance(); // struct/union/class
    let tag: string | null = null;
    if (this.cur().kind === 'ident' && !this.isPunct('{') && !this.isPunct(':')) {
      tag = this.cur().text;
      this.advance();
    }
    // Look up (or create) a single placeholder object per tag, up front. Self-referential
    // members (`struct Node* next;` inside `struct Node { ... }`) capture this same object by
    // reference; when the definition completes below we mutate it in place with Object.assign
    // so every earlier reference (including pointer fields already parsed) sees the real layout.
    const key = tag ? `${isUnion ? 'union' : 'struct'} ${tag}` : null;
    let placeholder: CType;
    if (key && this.tags.has(key)) {
      placeholder = this.tags.get(key)!;
    } else {
      placeholder = { kind: isUnion ? 'union' : 'struct', size: 0, align: 1, tag: tag ?? undefined, fields: [] };
      if (key) this.tags.set(key, placeholder);
    }
    // C++ (unlike C) allows a class/struct name to be used as a type-name on its own, without a
    // leading `struct`/`class` keyword — register it the same way a typedef would be.
    if (this.cpp && tag) {
      this.typedefScopes[0].add(tag);
      this.registerTypedef(tag, placeholder);
    }
    // Single inheritance only: the first base in the list is used, the rest (multiple
    // inheritance) are parsed and discarded — documented gap.
    let baseType: CType | undefined;
    if (this.isPunct(':')) {
      this.advance();
      do {
        while (this.isKw('public') || this.isKw('private') || this.isKw('protected') || this.isKw('virtual')) this.advance();
        const baseName = this.expectIdent();
        if (!baseType) {
          baseType = this.typedefTable.get(baseName) ?? this.tags.get(`struct ${baseName}`) ?? this.tags.get(`class ${baseName}`);
        }
      } while (this.eatPunct(','));
    }
    if (baseType) {
      placeholder.baseType = baseType;
      // Flatten: copy the base's (already-flattened) methods in as a starting point so plain name
      // lookup finds inherited methods with no base-chain walk; own declarations below override
      // matching entries in place (preserving vtable slot order) or append new ones.
      placeholder.methods = (baseType.methods ?? []).map((m) => ({ ...m }));
      if (baseType.dtorName) placeholder.dtorName = baseType.dtorName;
    }
    let anyCtor = false;
    if (this.eatPunct('{')) {
      const fields: { name: string; type: CType }[] = [];
      while (!this.isPunct('}')) {
        if ((this.isKw('public') || this.isKw('private') || this.isKw('protected')) && this.peek(1).kind === 'punct' && this.peek(1).text === ':') {
          this.advance();
          this.advance();
          continue;
        }
        let memberIsVirtual = false;
        if (this.cpp && this.isKw('virtual')) {
          memberIsVirtual = true;
          this.advance();
        }
        if (this.cpp && this.isPunct('~') && tag && this.isKw(tag, 1)) {
          this.advance();
          const methodName = '~' + this.advance().text;
          this.parseMemberFunction(placeholder, tag, methodName, Types.void, false, true, memberIsVirtual);
          continue;
        }
        if (this.cpp && tag && this.isKw(tag) && this.peek(1).kind === 'punct' && this.peek(1).text === '(') {
          const methodName = this.advance().text;
          anyCtor = true;
          this.parseMemberFunction(placeholder, tag, methodName, Types.void, true, false, false);
          continue;
        }
        const spec = this.parseDeclSpecifiers();
        if (this.eatPunct(';')) continue; // anonymous member (e.g. unnamed nested struct) — skip
        let sawMethod = false;
        for (;;) {
          const d = this.parseDeclarator(spec.type);
          if (!d.name) throw new ParseError('expected member name', this.cur());
          if (this.cpp && d.type.kind === 'function' && (this.isPunct('{') || this.isPunct(';'))) {
            // parseMemberFunctionRest already consumes the trailing ';' (prototype) or '{...}' (body) — no comma-list continuation applies to methods.
            this.parseMemberFunctionRest(placeholder, tag ?? '<anon>', d.name, d.type, memberIsVirtual);
            sawMethod = true;
            break;
          }
          if (this.eatPunct(':')) {
            this.parseConditional(); // bit-field width: parsed and discarded (bit-fields unsupported)
          }
          fields.push({ name: d.name, type: d.type });
          if (!this.eatPunct(',')) break;
        }
        if (!sawMethod) this.expectPunct(';');
      }
      this.expectPunct('}');
      const hasVtable = !!(placeholder.methods?.some((m) => m.isVirtual) || baseType?.hasVtable);
      const needsOwnVptr = hasVtable && !baseType?.hasVtable;
      const completed = makeStruct(tag ?? `<anon@${this.pos}>`, fields, isUnion, baseType, needsOwnVptr);
      Object.assign(placeholder, completed);
      placeholder.hasVtable = hasVtable;
      placeholder.baseFieldOffset = needsOwnVptr ? 4 : 0;
      // A class with a vtable but no user-declared constructor still needs one to run, purely to
      // stamp the vtable pointer into new objects — otherwise it stays uninitialized garbage and
      // virtual calls on it are undefined behavior.
      if (hasVtable && !anyCtor && tag) {
        const mangled = `${tag}__${tag}`;
        const fn: FunctionDecl = {
          kind: 'FunctionDecl', name: mangled, type: functionType([pointerTo(placeholder)], Types.void, false, ['this']),
          paramNames: ['this'], body: { kind: 'Compound', body: [], pos: this.pos_() },
          isStatic: false, className: tag, isCtor: true, memberInits: [], pos: this.pos_(),
        };
        this.pendingMethodDecls.push(fn);
        placeholder.ctorName = mangled;
      }
      void isClass;
      return placeholder;
    }
    if (!tag) throw new ParseError('expected struct/union/class tag or body', this.cur());
    return placeholder;
  }

  /** Adds or overrides a method entry on a class's flattened method list. An override (same name
   * as an inherited entry) replaces it in place — preserving vtable slot order — and is virtual
   * if either the base's entry or this declaration says so (matching real C++: overriding a
   * virtual method is implicitly virtual even without repeating the keyword). */
  private registerMethod(classType: CType, name: string, mangledName: string, type: CType, isVirtual: boolean): void {
    const list = (classType.methods ??= []);
    const existing = list.find((m) => m.name === name);
    if (existing) {
      existing.mangledName = mangledName;
      existing.type = type;
      existing.isVirtual = existing.isVirtual || isVirtual;
    } else {
      list.push({ name, mangledName, type, isVirtual });
    }
  }

  /** Parses a constructor (`Foo(...)`) or destructor (`~Foo()`) body/prototype. */
  private parseMemberFunction(classType: CType, className: string, methodName: string, returnType: CType, isCtor: boolean, isDtor: boolean, isVirtual: boolean): void {
    this.expectPunct('(');
    const { params, names } = this.parseParamList();
    this.expectPunct(')');
    while (this.isKw('const') || this.isKw('override') || this.isKw('noexcept')) this.advance();
    const mangled = `${className}__${isDtor ? 'dtor' : methodName}`;
    const fullParams = [pointerTo(classType), ...params];
    const fullNames = ['this', ...names];
    const type = functionType(fullParams, returnType, false, fullNames);

    // Member-initializer list (`: field(args...), field2(args...)`). Resolved at codegen time
    // (not here) because whether `field(args)` means "call field's own constructor" or "assign
    // this single value" depends on field's type, which isn't fully known until the enclosing
    // class's body finishes parsing — see CodeGenerator.emitMemberInits. No base-class
    // delegation (no inheritance) and no aggregate/brace-init member expressions.
    const memberInits: { field: string; args: Expr[]; pos: Pos }[] = [];
    if (this.isPunct(':')) {
      this.advance();
      do {
        const pos = this.pos_();
        const fieldName = this.expectIdent();
        const open = this.isPunct('(') ? '(' : this.isPunct('{') ? '{' : null;
        if (!open) throw new ParseError('expected member-initializer arguments', this.cur());
        this.advance();
        const args: Expr[] = [];
        if (!this.isPunct(open === '(' ? ')' : '}')) {
          args.push(this.parseAssignment());
          while (this.eatPunct(',')) args.push(this.parseAssignment());
        }
        this.expectPunct(open === '(' ? ')' : '}');
        memberInits.push({ field: fieldName, args, pos });
      } while (this.eatPunct(','));
    }

    let body = null;
    if (this.isPunct('{')) {
      body = this.parseCompound();
    } else {
      this.expectPunct(';');
    }
    const fn: FunctionDecl = {
      kind: 'FunctionDecl', name: mangled, type, paramNames: fullNames, body,
      isStatic: false, className, isCtor, isDtor, isVirtual, memberInits, pos: this.pos_(),
    };
    this.pendingMethodDecls.push(fn);
    this.registerMethod(classType, methodName, mangled, type, isVirtual);
    if (isCtor && params.length === 0) classType.ctorName = mangled;
    if (isDtor) classType.dtorName = mangled;
  }

  /** Parses the remainder of an ordinary method whose return type + name + params were already consumed as a normal declarator. */
  private parseMemberFunctionRest(classType: CType, className: string, methodName: string, funcType: CType, isVirtual: boolean): void {
    const mangled = `${className}__${methodName}`;
    const fullParams = [pointerTo(classType), ...funcType.params!];
    const fullNames = ['this', ...(funcType.paramNames ?? [])];
    const type = functionType(fullParams, funcType.returns!, funcType.variadic ?? false, fullNames);
    let body = null;
    if (this.isPunct('{')) body = this.parseCompound();
    else this.expectPunct(';');
    const fn: FunctionDecl = {
      kind: 'FunctionDecl', name: mangled, type, paramNames: fullNames, body,
      isStatic: false, className, isVirtual, pos: this.pos_(),
    };
    this.pendingMethodDecls.push(fn);
    this.registerMethod(classType, methodName, mangled, type, isVirtual);
  }

  private parseEnumSpecifier(): CType {
    this.advance(); // enum
    let tag: string | null = null;
    if (this.cur().kind === 'ident' && !this.isPunct('{')) {
      tag = this.cur().text;
      this.advance();
    }
    const enumType: CType = { kind: 'enum', size: 4, align: 4, tag: tag ?? undefined, underlying: Types.int };
    if (this.eatPunct('{')) {
      let next = 0n;
      while (!this.isPunct('}')) {
        const name = this.expectIdent();
        if (this.eatPunct('=')) next = this.evalConstInt(this.parseConditional());
        this.enumConsts.set(name, next);
        next += 1n;
        if (!this.eatPunct(',')) break;
      }
      this.expectPunct('}');
      if (tag) this.tags.set(`enum ${tag}`, enumType);
    } else if (tag) {
      const existing = this.tags.get(`enum ${tag}`);
      if (existing) return existing;
      this.tags.set(`enum ${tag}`, enumType);
    }
    return enumType;
  }

  getEnumConstants(): Map<string, bigint> {
    return this.enumConsts;
  }

  // ---------- declarators (chibicc-style placeholder backpatching) ----------

  private parseDeclarator(base: CType): { name: string | null; type: CType } {
    let type = base;
    while (this.eatPunct('*')) {
      while (QUALIFIER_KEYWORDS.has(this.cur().text) && this.cur().kind === 'ident') this.advance();
      type = pointerTo(type);
    }
    // C++ references (`int &r`, `int *&pr`) — one level only (no rvalue references: a literal
    // `&&` token is its own punctuator, distinct from `&`, so it's simply not matched here).
    if (this.cpp && this.isPunct('&')) {
      this.advance();
      while (QUALIFIER_KEYWORDS.has(this.cur().text) && this.cur().kind === 'ident') this.advance();
      type = referenceTo(type);
    }
    if (this.eatPunct('(')) {
      // Could be a parenthesized declarator (grouping) OR a K&R-style function without params
      // immediately at top level. We only ever call this from contexts where the former applies.
      const placeholder = {} as CType;
      const inner = this.parseDeclarator(placeholder);
      this.expectPunct(')');
      const outer = this.parseTypeSuffix(type);
      Object.assign(placeholder, outer);
      return inner;
    }
    let name: string | null = null;
    if (this.cpp && this.isKw('operator')) {
      // Operator overloading (`Vector2D operator+(Vector2D o)`): named as "operator" + the
      // symbol, resolved at codegen time by rewriting `a + b` into `a.operator+(b)` when `a`'s
      // type has a matching method (see codegen's operatorBinaryCall/operatorUnaryCall/
      // operatorIndexCall). Only single-punctuator operators plus `[]` are recognized — no
      // `operator()`, compound-assignment, or conversion operators (documented gap).
      this.advance();
      if (this.eatPunct('[')) {
        this.expectPunct(']');
        name = 'operator[]';
      } else if (this.cur().kind === 'punct') {
        name = 'operator' + this.advance().text;
      } else {
        throw new ParseError('expected an operator symbol after \'operator\'', this.cur());
      }
    } else if (this.cur().kind === 'ident' && !TYPE_KEYWORDS.has(this.cur().text)) {
      name = this.advance().text;
    }
    type = this.parseTypeSuffix(type);
    return { name, type };
  }

  private parseTypeSuffix(base: CType): CType {
    if (this.eatPunct('[')) {
      let len: number | null = null;
      if (!this.isPunct(']')) {
        len = Number(this.evalConstInt(this.parseConditional()));
      }
      this.expectPunct(']');
      const inner = this.parseTypeSuffix(base);
      return arrayOf(inner, len);
    }
    if (this.eatPunct('(')) {
      const { params, names, variadic } = this.parseParamList();
      this.expectPunct(')');
      return functionType(params, base, variadic, names);
    }
    return base;
  }

  private parseParamList(): { params: CType[]; names: string[]; variadic: boolean } {
    const params: CType[] = [];
    const names: string[] = [];
    let variadic = false;
    if (this.isPunct(')')) return { params, names, variadic };
    if (this.isKw('void') && this.peek(1).kind === 'punct' && this.peek(1).text === ')') {
      this.advance();
      return { params, names, variadic };
    }
    for (;;) {
      if (this.eatPunct('...')) {
        variadic = true;
        break;
      }
      const spec = this.parseDeclSpecifiers();
      const d = this.parseDeclarator(spec.type);
      // array/function parameters decay to pointer/function-pointer per C rules.
      let pt = d.type;
      if (pt.kind === 'array') pt = pointerTo(pt.pointee!);
      else if (pt.kind === 'function') pt = pointerTo(pt);
      params.push(pt);
      names.push(d.name ?? `__p${params.length}`);
      if (!this.eatPunct(',')) break;
    }
    return { params, names, variadic };
  }

  /** Parses a standalone type-name (for casts / sizeof): decl-specifiers + optional abstract declarator. */
  parseTypeName(): CType {
    const spec = this.parseDeclSpecifiers();
    if (this.isPunct(')') || this.isPunct(',')) return spec.type;
    const d = this.parseDeclarator(spec.type);
    return d.type;
  }

  // ---------- statements ----------

  parseCompound(): Stmt {
    const pos = this.pos_();
    this.expectPunct('{');
    this.pushScope();
    const body: Stmt[] = [];
    while (!this.isPunct('}') && !this.atEof()) {
      body.push(this.parseBlockItem());
    }
    this.expectPunct('}');
    this.popScope();
    return { kind: 'Compound', body, pos };
  }

  private parseBlockItem(): Stmt {
    if (this.startsDeclSpec()) {
      return this.parseDeclStmt();
    }
    return this.parseStatement();
  }

  private parseDeclStmt(): Stmt {
    const pos = this.pos_();
    const spec = this.parseDeclSpecifiers();

    // C++ direct-initialization: `ClassName obj(args...);`. Unambiguous in practice — the
    // "most vexing parse" only bites when the parenthesized content could *also* be a valid
    // parameter-type-list, which essentially never happens for argument expressions (literals,
    // other locals, etc. aren't type-names), so we don't attempt full disambiguation.
    if (this.cpp && !spec.isTypedef && spec.type.kind === 'struct' && this.cur().kind === 'ident' && this.isPunct('(', 1)) {
      const name = this.advance().text;
      this.advance(); // '('
      const args: Expr[] = [];
      if (!this.isPunct(')')) {
        args.push(this.parseAssignment());
        while (this.eatPunct(',')) args.push(this.parseAssignment());
      }
      this.expectPunct(')');
      this.expectPunct(';');
      const decl: VarDecl = { kind: 'VarDecl', name, type: spec.type, init: null, ctorArgs: args, isStatic: spec.isStatic, isExtern: spec.isExtern, pos };
      return { kind: 'DeclStmt', decls: [decl], pos };
    }

    const decls: VarDecl[] = [];
    if (!this.isPunct(';')) {
      for (;;) {
        const d = this.parseDeclarator(spec.type);
        if (spec.isTypedef) {
          if (d.name) {
            this.typedefScopes[this.typedefScopes.length - 1].add(d.name);
            this.registerTypedef(d.name, d.type);
          }
        } else {
          let init: Expr | null = null;
          if (this.eatPunct('=')) init = this.parseInitializer();
          if (!d.name) throw new ParseError('expected declarator name', this.cur());
          decls.push({ kind: 'VarDecl', name: d.name, type: this.resolveIncompleteArraySize(d.type, init), init, isStatic: spec.isStatic, isExtern: spec.isExtern, pos });
        }
        if (!this.eatPunct(',')) break;
      }
    }
    this.expectPunct(';');
    return { kind: 'DeclStmt', decls, pos };
  }

  private parseStatement(): Stmt {
    const pos = this.pos_();
    const t = this.cur();

    if (this.isPunct('{')) return this.parseCompound();
    if (this.eatPunct(';')) return { kind: 'Empty', pos };

    if (t.kind === 'ident') {
      switch (t.text) {
        case 'if': {
          this.advance();
          this.expectPunct('(');
          const cond = this.parseExpr();
          this.expectPunct(')');
          const then = this.parseStatement();
          let els: Stmt | null = null;
          if (this.eatKw('else')) els = this.parseStatement();
          return { kind: 'If', cond, then, else: els, pos };
        }
        case 'while': {
          this.advance();
          this.expectPunct('(');
          const cond = this.parseExpr();
          this.expectPunct(')');
          const body = this.parseStatement();
          return { kind: 'While', cond, body, pos };
        }
        case 'do': {
          this.advance();
          const body = this.parseStatement();
          if (!this.eatKw('while')) throw new ParseError("expected 'while'", this.cur());
          this.expectPunct('(');
          const cond = this.parseExpr();
          this.expectPunct(')');
          this.expectPunct(';');
          return { kind: 'DoWhile', cond, body, pos };
        }
        case 'for': {
          this.advance();
          this.expectPunct('(');
          this.pushScope();
          let init: Stmt | null = null;
          if (!this.isPunct(';')) {
            init = this.startsDeclSpec() ? this.parseDeclStmt() : { kind: 'ExprStmt', expr: this.parseExpr(), pos: this.pos_() };
            if (init.kind === 'ExprStmt') this.expectPunct(';');
          } else {
            this.advance();
          }
          const cond = this.isPunct(';') ? null : this.parseExpr();
          this.expectPunct(';');
          const step = this.isPunct(')') ? null : this.parseExpr();
          this.expectPunct(')');
          const body = this.parseStatement();
          this.popScope();
          return { kind: 'For', init, cond, step, body, pos };
        }
        case 'return': {
          this.advance();
          const expr = this.isPunct(';') ? null : this.parseExpr();
          this.expectPunct(';');
          return { kind: 'Return', expr, pos };
        }
        case 'break':
          this.advance(); this.expectPunct(';');
          return { kind: 'Break', pos };
        case 'continue':
          this.advance(); this.expectPunct(';');
          return { kind: 'Continue', pos };
        case 'switch': {
          this.advance();
          this.expectPunct('(');
          const expr = this.parseExpr();
          this.expectPunct(')');
          const body = this.parseStatement();
          return { kind: 'Switch', expr, body, pos };
        }
        case 'case': {
          this.advance();
          const expr = this.parseConditional();
          this.expectPunct(':');
          return { kind: 'Case', expr, pos };
        }
        case 'default':
          this.advance(); this.expectPunct(':');
          return { kind: 'Default', pos };
        case 'goto': {
          this.advance();
          const name = this.expectIdent();
          this.expectPunct(';');
          return { kind: 'Goto', name, pos };
        }
        default:
          break;
      }
      if (t.kind === 'ident' && this.peek(1).kind === 'punct' && this.peek(1).text === ':' && !this.startsDeclSpec()) {
        const name = this.advance().text;
        this.advance(); // ':'
        return { kind: 'Label', name, pos };
      }
    }

    const expr = this.parseExpr();
    this.expectPunct(';');
    return { kind: 'ExprStmt', expr, pos };
  }

  // ---------- initializers ----------

  parseInitializer(): Expr {
    const pos = this.pos_();
    if (this.eatPunct('{')) {
      const items: Expr[] = [];
      while (!this.isPunct('}')) {
        items.push(this.parseInitializer());
        if (!this.eatPunct(',')) break;
      }
      this.expectPunct('}');
      return { kind: 'InitList', items, pos };
    }
    return this.parseAssignment();
  }

  // ---------- expressions ----------

  parseExpr(): Expr {
    let e = this.parseAssignment();
    while (this.isPunct(',')) {
      const pos = this.pos_();
      this.advance();
      const right = this.parseAssignment();
      e = { kind: 'Comma', left: e, right, pos };
    }
    return e;
  }

  private ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

  private parseAssignment(): Expr {
    const left = this.parseConditional();
    const t = this.cur();
    if (t.kind === 'punct' && this.ASSIGN_OPS.has(t.text)) {
      const pos = this.pos_();
      this.advance();
      const value = this.parseAssignment();
      return { kind: 'Assign', op: t.text, target: left, value, pos };
    }
    return left;
  }

  private parseConditional(): Expr {
    const cond = this.parseLogicalOr();
    if (this.eatPunct('?')) {
      const pos = this.pos_();
      const then = this.parseExpr();
      this.expectPunct(':');
      const els = this.parseConditional();
      return { kind: 'Cond', cond, then, else: els, pos };
    }
    return cond;
  }

  private binaryLevel(ops: string[], next: () => Expr): Expr {
    let e = next();
    for (;;) {
      const t = this.cur();
      if (t.kind !== 'punct' || !ops.includes(t.text)) break;
      const pos = this.pos_();
      this.advance();
      const right = next();
      e = { kind: 'Binary', op: t.text, left: e, right, pos };
    }
    return e;
  }

  private parseLogicalOr(): Expr { return this.binaryLevel(['||'], () => this.parseLogicalAnd()); }
  private parseLogicalAnd(): Expr { return this.binaryLevel(['&&'], () => this.parseBitOr()); }
  private parseBitOr(): Expr { return this.binaryLevel(['|'], () => this.parseBitXor()); }
  private parseBitXor(): Expr { return this.binaryLevel(['^'], () => this.parseBitAnd()); }
  private parseBitAnd(): Expr { return this.binaryLevel(['&'], () => this.parseEquality()); }
  private parseEquality(): Expr { return this.binaryLevel(['==', '!='], () => this.parseRelational()); }
  private parseRelational(): Expr { return this.binaryLevel(['<', '>', '<=', '>='], () => this.parseShift()); }
  private parseShift(): Expr { return this.binaryLevel(['<<', '>>'], () => this.parseAdditive()); }
  private parseAdditive(): Expr { return this.binaryLevel(['+', '-'], () => this.parseMultiplicative()); }
  private parseMultiplicative(): Expr { return this.binaryLevel(['*', '/', '%'], () => this.parseCast()); }

  private looksLikeTypeStart(o = 0): boolean {
    const t = this.peek(o);
    if (t.kind !== 'ident') return false;
    return TYPE_KEYWORDS.has(t.text) || QUALIFIER_KEYWORDS.has(t.text) || t.text === 'struct' || t.text === 'union' || t.text === 'enum' || this.isTypeName(t.text);
  }

  private parseCast(): Expr {
    if (this.isPunct('(') && this.looksLikeTypeStart(1)) {
      const save = this.pos;
      const pos = this.pos_();
      this.advance();
      const targetType = this.parseTypeName();
      if (this.isPunct(')')) {
        this.advance();
        if (this.isPunct('{')) {
          // Compound literal `(Type){...}` — treat as an initializer list of that type.
          const initList = this.parseInitializer();
          return { ...initList, type: targetType } as Expr;
        }
        const operand = this.parseCast();
        return { kind: 'Cast', targetType, operand, pos };
      }
      this.pos = save; // not actually a cast; back off and parse as a parenthesized expression
    }
    return this.parseUnary();
  }

  private parseUnary(): Expr {
    const pos = this.pos_();
    const t = this.cur();
    if (t.kind === 'punct' && ['+', '-', '!', '~', '*', '&'].includes(t.text)) {
      this.advance();
      const operand = this.parseCast();
      return { kind: 'Unary', op: t.text, operand, prefix: true, pos };
    }
    if (t.kind === 'punct' && (t.text === '++' || t.text === '--')) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.text, operand, prefix: true, pos };
    }
    if (t.kind === 'ident' && t.text === 'sizeof') {
      this.advance();
      if (this.isPunct('(') && this.looksLikeTypeStart(1)) {
        this.advance();
        const targetType = this.parseTypeName();
        this.expectPunct(')');
        return { kind: 'SizeofType', targetType, pos };
      }
      const operand = this.parseUnary();
      return { kind: 'SizeofExpr', operand, pos };
    }
    if (t.kind === 'ident' && t.text === 'va_arg') {
      this.advance();
      this.expectPunct('(');
      const apExpr = this.parseAssignment();
      this.expectPunct(',');
      const targetType = this.parseTypeName();
      this.expectPunct(')');
      // va_arg needs to pick the right builtin reader for the argument's storage width/kind
      // (see runtime/libc.ts's variadic calling convention); the resulting value keeps that
      // builtin's canonical type (int/long/double) rather than the exact requested type, which
      // is behaviorally equivalent for arithmetic/printing in the realistic cases this covers.
      const variant = is64BitInt(targetType) ? 'i64' : isFloatType(targetType) ? 'f64' : 'i32';
      return { kind: 'Call', callee: { kind: 'Ident', name: `__builtin_va_arg_${variant}`, pos }, args: [apExpr], pos };
    }
    if (this.cpp) {
      if (t.kind === 'ident' && t.text === 'new') {
        this.advance();
        // Deliberately not the general parseTypeName(): that greedily consumes a trailing '('
        // as an abstract *function* declarator, which is wrong here — `(...)` after the type in
        // a new-expression is always the constructor argument list. `new T[n]` (array-new) isn't
        // supported (documented gap, alongside the matching `delete[]` limitation).
        const targetType = this.parseDeclSpecifiers().type;
        const args: Expr[] = [];
        if (this.eatPunct('(')) {
          if (!this.isPunct(')')) {
            args.push(this.parseAssignment());
            while (this.eatPunct(',')) args.push(this.parseAssignment());
          }
          this.expectPunct(')');
        }
        return { kind: 'New', targetType, args, pos };
      }
      if (t.kind === 'ident' && t.text === 'delete') {
        this.advance();
        const isArray = this.isPunct('[') && this.isPunct(']', 1);
        if (isArray) { this.advance(); this.advance(); }
        const operand = this.parseUnary();
        return { kind: 'Delete', operand, isArray, pos };
      }
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const pos = this.pos_();
      if (this.eatPunct('[')) {
        const index = this.parseExpr();
        this.expectPunct(']');
        e = { kind: 'Index', base: e, index, pos };
      } else if (this.eatPunct('(')) {
        const args: Expr[] = [];
        if (!this.isPunct(')')) {
          args.push(this.parseAssignment());
          while (this.eatPunct(',')) args.push(this.parseAssignment());
        }
        this.expectPunct(')');
        e = { kind: 'Call', callee: e, args, pos };
      } else if (this.eatPunct('.')) {
        const field = this.expectIdent();
        e = { kind: 'Member', base: e, field, arrow: false, pos };
      } else if (this.eatPunct('->')) {
        const field = this.expectIdent();
        e = { kind: 'Member', base: e, field, arrow: true, pos };
      } else if (this.isPunct('++') || this.isPunct('--')) {
        const op = this.advance().text;
        e = { kind: 'Unary', op, operand: e, prefix: false, pos };
      } else {
        break;
      }
    }
    return e;
  }

  private parsePrimary(): Expr {
    const pos = this.pos_();
    const t = this.cur();
    if (t.kind === 'num') {
      this.advance();
      return this.parseNumberLiteral(t.text, pos);
    }
    if (t.kind === 'string') {
      let value = t.value;
      this.advance();
      while (this.cur().kind === 'string') value += this.advance().value;
      return { kind: 'StringLit', value, pos };
    }
    if (t.kind === 'char') {
      this.advance();
      return { kind: 'CharLit', value: t.value.charCodeAt(0) || 0, pos };
    }
    if (t.kind === 'ident') {
      if (this.cpp && t.text === 'true') { this.advance(); return { kind: 'BoolLit', value: true, pos }; }
      if (this.cpp && t.text === 'false') { this.advance(); return { kind: 'BoolLit', value: false, pos }; }
      if (this.cpp && t.text === 'nullptr') { this.advance(); return { kind: 'Nullptr', pos }; }
      // `this` reuses the ordinary Ident machinery (it's already how codegen synthesizes implicit
      // `this->field` accesses internally) rather than the otherwise-unhandled dedicated `This`
      // AST node — see ast.ts's comment on that variant.
      if (this.cpp && t.text === 'this') { this.advance(); return { kind: 'Ident', name: 'this', pos }; }
      // Enum constants are resolved directly to literals here, at parse time: codegen has no
      // notion of them (they were never registered as locals or globals), and this also makes
      // them usable anywhere a compile-time constant is required (case labels, array sizes).
      const enumValue = this.enumConsts.get(t.text);
      if (enumValue !== undefined) {
        this.advance();
        return { kind: 'IntLit', value: enumValue, pos };
      }
      // `ClassName(args)` as an expression (a temporary object) — distinct from `ClassName obj(args);`
      // as a declaration, which parseDeclStmt already handles. Only triggers for known class/struct
      // type names so it never shadows an ordinary function call.
      if (this.cpp && this.isPunct('(', 1)) {
        const resolvedType = this.typedefTable.get(t.text);
        if (resolvedType && (resolvedType.kind === 'struct' || resolvedType.kind === 'union')) {
          this.advance(); // type name
          this.advance(); // '('
          const args: Expr[] = [];
          if (!this.isPunct(')')) {
            args.push(this.parseAssignment());
            while (this.eatPunct(',')) args.push(this.parseAssignment());
          }
          this.expectPunct(')');
          return { kind: 'TempObject', targetType: resolvedType, args, pos };
        }
      }
      this.advance();
      return { kind: 'Ident', name: t.text, pos };
    }
    if (this.eatPunct('(')) {
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    throw new ParseError('expected expression', t);
  }

  private parseNumberLiteral(text: string, pos: Pos): Expr {
    const m = /^(.*?)([uUlLfF]*)$/.exec(text)!;
    let digits = m[1];
    const suffix = m[2].toLowerCase();
    const isFloatLiteral = digits.includes('.') || (/e/i.test(digits) && !digits.startsWith('0x')) || suffix.includes('f');
    if (isFloatLiteral) {
      return { kind: 'FloatLit', value: parseFloat(digits), isFloat: suffix.includes('f'), pos };
    }
    const value = digits.startsWith('0x') || digits.startsWith('0X')
      ? BigInt(digits)
      : digits.startsWith('0') && digits.length > 1
        ? BigInt(parseInt(digits, 8))
        : BigInt(digits);
    return { kind: 'IntLit', value, pos };
  }

  // ---------- constant expression evaluation (array sizes, enum values) ----------

  evalConstInt(e: Expr): bigint {
    switch (e.kind) {
      case 'IntLit': return e.value;
      case 'CharLit': return BigInt(e.value);
      case 'Ident': {
        const v = this.enumConsts.get(e.name);
        if (v !== undefined) return v;
        throw new ParseError(`'${e.name}' is not a constant expression`, this.cur());
      }
      case 'Unary': {
        const v = this.evalConstInt(e.operand);
        switch (e.op) {
          case '-': return -v;
          case '+': return v;
          case '!': return v === 0n ? 1n : 0n;
          case '~': return ~v;
          default: throw new ParseError(`operator '${e.op}' not allowed in constant expression`, this.cur());
        }
      }
      case 'Binary': {
        const a = this.evalConstInt(e.left);
        const b = this.evalConstInt(e.right);
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '==': return a === b ? 1n : 0n;
          case '!=': return a !== b ? 1n : 0n;
          case '<': return a < b ? 1n : 0n;
          case '>': return a > b ? 1n : 0n;
          case '<=': return a <= b ? 1n : 0n;
          case '>=': return a >= b ? 1n : 0n;
          case '&&': return a !== 0n && b !== 0n ? 1n : 0n;
          case '||': return a !== 0n || b !== 0n ? 1n : 0n;
          default: throw new ParseError(`operator '${e.op}' not allowed in constant expression`, this.cur());
        }
      }
      case 'Cond': {
        const c = this.evalConstInt(e.cond);
        return c !== 0n ? this.evalConstInt(e.then) : this.evalConstInt(e.else);
      }
      case 'SizeofType':
        return BigInt(e.targetType.size);
      default:
        throw new ParseError('not a constant expression', this.cur());
    }
  }

}
