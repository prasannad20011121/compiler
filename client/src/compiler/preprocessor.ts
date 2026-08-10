import { tokenize, type Token } from './lexer.ts';

export class PreprocessorError extends Error {
  constructor(message: string, file: string, line: number) {
    super(`${file}:${line}: ${message}`);
  }
}

interface Macro {
  name: string;
  params: string[] | null; // null => object-like
  variadic: boolean;
  body: Token[];
}

export interface FileResolver {
  /** Resolve a quoted #include "..." relative to the including file. Returns source text, or undefined if not found. */
  resolveQuoted(specifier: string, fromFile: string): { path: string; text: string } | undefined;
  /** Resolve an angle-bracket #include <...>. We only ship a handful of stub/system headers (mostly no-ops). */
  resolveAngle(specifier: string): { path: string; text: string } | undefined;
}

function cloneTok(t: Token, noExpand?: Set<string>): Token {
  return { ...t, noExpand: noExpand ?? t.noExpand };
}

/** Tags freshly-produced expansion tokens with the union of their own hide set, `baseHide` (inherited from the invocation), and `name` (the macro just expanded) — this is what prevents runaway self/mutual recursion. */
function withHide(tokens: Token[], name: string, baseHide: Set<string> = new Set()): Token[] {
  return tokens.map((t) => {
    const hide = new Set(t.noExpand ?? []);
    for (const h of baseHide) hide.add(h);
    hide.add(name);
    return cloneTok(t, hide);
  });
}

export class Preprocessor {
  private macros = new Map<string, Macro>();
  private includeStack: string[] = [];
  private resolver: FileResolver;

  constructor(resolver: FileResolver, predefined: Record<string, string> = {}) {
    this.resolver = resolver;
    for (const [name, value] of Object.entries(predefined)) {
      this.macros.set(name, { name, params: null, variadic: false, body: tokenize(value, '<builtin>').slice(0, -1) });
    }
  }

  isDefined(name: string): boolean {
    return this.macros.has(name);
  }

  /** Preprocess one file (entry point). Returns the final expanded C/C++ token stream (no directives, no eof duplication mid-stream). */
  preprocessFile(source: string, file: string): Token[] {
    this.includeStack.push(file);
    const raw = tokenize(source, file);
    const out = this.processLines(raw, file);
    this.includeStack.pop();
    out.push({ kind: 'eof', text: '', value: '', line: raw[raw.length - 1].line, col: 1, file, atLineStart: true, spaceBefore: true });
    return out;
  }

  private processLines(raw: Token[], file: string): Token[] {
    const out: Token[] = [];
    // condStack entries: whether the branch's *own* condition is true, whether *any* branch in this
    // if-chain has been taken yet, and whether we're currently inside an active (emitting) region.
    const condStack: { taken: boolean; active: boolean; parentActive: boolean }[] = [];

    const isActive = () => condStack.every((c) => c.active);

    let i = 0;
    while (i < raw.length && raw[i].kind !== 'eof') {
      const t = raw[i];
      if (t.atLineStart && t.kind === 'punct' && t.text === '#') {
        const lineNo = t.line;
        let j = i + 1;
        const directiveLine: Token[] = [];
        while (j < raw.length && raw[j].kind !== 'eof' && raw[j].line === lineNo && !(raw[j].atLineStart && j !== i + 1)) {
          directiveLine.push(raw[j]);
          j++;
        }
        i = j;
        this.handleDirective(directiveLine, file, lineNo, condStack, isActive, out);
        continue;
      }
      if (isActive()) {
        out.push(t);
      }
      i++;
    }
    if (condStack.length > 0) {
      throw new PreprocessorError(`unterminated #if (missing #endif)`, file, raw[raw.length - 1]?.line ?? 0);
    }
    return this.expandAll(out);
  }

  private handleDirective(
    line: Token[],
    file: string,
    lineNo: number,
    condStack: { taken: boolean; active: boolean; parentActive: boolean }[],
    isActive: () => boolean,
    out: Token[],
  ): void {
    if (line.length === 0) return; // bare '#'
    const kw = line[0];
    const name = kw.kind === 'ident' ? kw.text : '';
    const parentActive = isActive();

    const pushCond = (condTrue: boolean) => {
      condStack.push({ taken: condTrue, active: parentActive && condTrue, parentActive });
    };

    switch (name) {
      case 'ifdef': {
        const id = line[1]?.text;
        pushCond(!!id && this.macros.has(id));
        return;
      }
      case 'ifndef': {
        const id = line[1]?.text;
        pushCond(!(id && this.macros.has(id)));
        return;
      }
      case 'if': {
        const expr = line.slice(1);
        pushCond(parentActive ? this.evalConstExpr(expr, file, lineNo) !== 0 : false);
        return;
      }
      case 'elif': {
        const top = condStack.pop();
        if (!top) throw new PreprocessorError('#elif without #if', file, lineNo);
        const grandParentActive = top.parentActive;
        const cond = !top.taken && grandParentActive && this.evalConstExpr(line.slice(1), file, lineNo) !== 0;
        condStack.push({ taken: top.taken || cond, active: cond, parentActive: grandParentActive });
        return;
      }
      case 'else': {
        const top = condStack.pop();
        if (!top) throw new PreprocessorError('#else without #if', file, lineNo);
        condStack.push({ taken: true, active: !top.taken && top.parentActive, parentActive: top.parentActive });
        return;
      }
      case 'endif': {
        if (condStack.length === 0) throw new PreprocessorError('#endif without #if', file, lineNo);
        condStack.pop();
        return;
      }
      default:
        break;
    }

    if (!parentActive) return; // skip everything else while inactive

    switch (name) {
      case 'define':
        this.defineMacro(line.slice(1), file, lineNo);
        return;
      case 'undef': {
        const id = line[1]?.text;
        if (id) this.macros.delete(id);
        return;
      }
      case 'include': {
        this.handleInclude(line.slice(1), file, lineNo, out);
        return;
      }
      case 'pragma':
      case 'error':
      case 'warning':
      case 'line':
        return; // no-ops for this compiler
      case '':
        return; // e.g. digits after # (line markers) — ignore
      default:
        // Unknown directive: ignore rather than fail the whole build.
        return;
    }
  }

  private defineMacro(rest: Token[], file: string, lineNo: number): void {
    if (rest.length === 0 || rest[0].kind !== 'ident') {
      throw new PreprocessorError('macro name missing', file, lineNo);
    }
    const macroName = rest[0].text;
    let idx = 1;
    let params: string[] | null = null;
    let variadic = false;
    if (rest[idx] && rest[idx].kind === 'punct' && rest[idx].text === '(' && !rest[idx].spaceBefore) {
      idx++;
      params = [];
      while (!(rest[idx]?.kind === 'punct' && rest[idx].text === ')')) {
        const p = rest[idx];
        if (!p) throw new PreprocessorError('unterminated macro parameter list', file, lineNo);
        if (p.kind === 'punct' && p.text === '...') {
          variadic = true;
          params.push('__VA_ARGS__');
          idx++;
          break;
        }
        if (p.kind !== 'ident') throw new PreprocessorError('bad macro parameter', file, lineNo);
        params.push(p.text);
        idx++;
        if (rest[idx]?.kind === 'punct' && rest[idx].text === ',') idx++;
      }
      idx++; // consume ')'
    }
    const body = rest.slice(idx);
    this.macros.set(macroName, { name: macroName, params, variadic, body });
  }

  private handleInclude(rest: Token[], file: string, lineNo: number, out: Token[]): void {
    if (rest.length === 0) throw new PreprocessorError('#include expects a filename', file, lineNo);
    const first = rest[0];
    let resolved: { path: string; text: string } | undefined;
    if (first.kind === 'string') {
      resolved = this.resolver.resolveQuoted(first.value, file);
    } else if (first.kind === 'punct' && first.text === '<') {
      let spec = '';
      let k = 1;
      while (k < rest.length && !(rest[k].kind === 'punct' && rest[k].text === '>')) {
        spec += rest[k].text;
        k++;
      }
      resolved = this.resolver.resolveAngle(spec);
    } else {
      // Possibly a macro that expands to a header name — expand then retry as a string.
      const expanded = this.expandAll(rest);
      if (expanded[0]?.kind === 'string') resolved = this.resolver.resolveQuoted(expanded[0].value, file);
    }
    if (!resolved) return; // unknown/system header: treated as a no-op (our runtime pre-declares libc symbols)
    if (this.includeStack.includes(resolved.path)) {
      throw new PreprocessorError(`circular #include of '${resolved.path}'`, file, lineNo);
    }
    if (this.includeStack.length > 200) {
      throw new PreprocessorError('#include nested too deeply', file, lineNo);
    }
    this.includeStack.push(resolved.path);
    const rawIncluded = tokenize(resolved.text, resolved.path);
    const expandedIncluded = this.processLines(rawIncluded, resolved.path);
    this.includeStack.pop();
    for (const t of expandedIncluded) out.push(t);
  }

  // ---- macro expansion ----

  private expandAll(tokens: Token[]): Token[] {
    const queue = tokens.slice();
    const out: Token[] = [];
    let guard = 0;
    while (queue.length > 0) {
      if (++guard > 2_000_000) throw new Error('macro expansion did not terminate');
      const t = queue.shift()!;
      if (t.kind !== 'ident') {
        out.push(t);
        continue;
      }
      const macro = this.macros.get(t.text);
      if (!macro || t.noExpand?.has(t.text)) {
        out.push(t);
        continue;
      }
      if (macro.params === null) {
        const expansion = withHide(macro.body, macro.name, t.noExpand);
        queue.unshift(...expansion);
        continue;
      }
      // Function-like: next token must be '(' or this identifier is left alone.
      if (!(queue[0]?.kind === 'punct' && queue[0].text === '(')) {
        out.push(t);
        continue;
      }
      queue.shift(); // '('
      const { args, trailingHide } = this.collectArgs(queue);
      const expandedArgs = args.map((a) => this.expandAll(a));
      const substituted = this.substitute(macro, expandedArgs);
      const baseHide = new Set([...(t.noExpand ?? []), ...trailingHide]);
      queue.unshift(...withHide(substituted, macro.name, baseHide));
      continue;
    }
    return out;
  }

  private collectArgs(queue: Token[]): { args: Token[][]; trailingHide: Set<string> } {
    const args: Token[][] = [];
    let current: Token[] = [];
    let depth = 0;
    let trailingHide = new Set<string>();
    while (true) {
      const t = queue.shift();
      if (!t || t.kind === 'eof') throw new Error('unterminated macro argument list');
      if (t.kind === 'punct' && t.text === '(') {
        depth++;
        current.push(t);
        continue;
      }
      if (t.kind === 'punct' && t.text === ')') {
        if (depth === 0) {
          args.push(current);
          trailingHide = new Set(t.noExpand ?? []);
          break;
        }
        depth--;
        current.push(t);
        continue;
      }
      if (t.kind === 'punct' && t.text === ',' && depth === 0) {
        args.push(current);
        current = [];
        continue;
      }
      current.push(t);
    }
    if (args.length === 1 && args[0].length === 0) return { args: [], trailingHide };
    return { args, trailingHide };
  }

  private substitute(macro: Macro, args: Token[][]): Token[] {
    const params = macro.params!;
    const out: Token[] = [];
    for (const t of macro.body) {
      if (t.kind === 'ident') {
        const pIdx = params.indexOf(t.text);
        if (pIdx !== -1) {
          const arg = macro.variadic && pIdx === params.length - 1
            ? joinVariadic(args, params.length - 1)
            : (args[pIdx] ?? []);
          out.push(...arg);
          continue;
        }
      }
      out.push(t);
    }
    return out;
  }

  // ---- #if constant expression evaluation ----

  private evalConstExpr(tokens: Token[], file: string, lineNo: number): number {
    const withDefined = this.resolveDefined(tokens);
    const expanded = this.expandAll(withDefined).filter((t) => t.kind !== 'eof');
    const normalized = expanded.map((t) =>
      t.kind === 'ident' ? { ...t, kind: 'num' as const, text: '0' } : t,
    );
    const parser = new ConstExprParser(normalized, file, lineNo);
    const value = parser.parseExpr();
    parser.expectEnd();
    return value;
  }

  private resolveDefined(tokens: Token[]): Token[] {
    const out: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'ident' && t.text === 'defined') {
        let id: string | undefined;
        if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1].text === '(') {
          id = tokens[i + 2]?.text;
          i += 3;
        } else {
          id = tokens[i + 1]?.text;
          i += 1;
        }
        out.push({ ...t, kind: 'num', text: id && this.macros.has(id) ? '1' : '0' });
        continue;
      }
      out.push(t);
    }
    return out;
  }
}

function joinVariadic(args: Token[][], fromIndex: number): Token[] {
  const parts = args.slice(fromIndex);
  const out: Token[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ kind: 'punct', text: ',', value: '', line: 0, col: 0, file: '<macro>', atLineStart: false, spaceBefore: false });
    out.push(...parts[i]);
  }
  return out;
}

/** Tiny recursive-descent evaluator for #if integer constant-expressions. */
class ConstExprParser {
  private pos = 0;
  private tokens: Token[];
  private file: string;
  private lineNo: number;
  constructor(tokens: Token[], file: string, lineNo: number) {
    this.tokens = tokens;
    this.file = file;
    this.lineNo = lineNo;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new PreprocessorError('unexpected end of #if expression', this.file, this.lineNo);
    this.pos++;
    return t;
  }
  private isPunct(text: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punct' && t.text === text;
  }
  expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new PreprocessorError(`unexpected token in #if expression: '${this.peek()?.text}'`, this.file, this.lineNo);
    }
  }

  parseExpr(): number {
    return this.parseTernary();
  }
  private parseTernary(): number {
    const cond = this.parseOr();
    if (this.isPunct('?')) {
      this.next();
      const a = this.parseTernary();
      if (!this.isPunct(':')) throw new PreprocessorError("expected ':' in #if", this.file, this.lineNo);
      this.next();
      const b = this.parseTernary();
      return cond !== 0 ? a : b;
    }
    return cond;
  }
  private parseOr(): number {
    let v = this.parseAnd();
    while (this.isPunct('||')) { this.next(); const r = this.parseAnd(); v = (v !== 0 || r !== 0) ? 1 : 0; }
    return v;
  }
  private parseAnd(): number {
    let v = this.parseBitOr();
    while (this.isPunct('&&')) { this.next(); const r = this.parseBitOr(); v = (v !== 0 && r !== 0) ? 1 : 0; }
    return v;
  }
  private parseBitOr(): number {
    let v = this.parseBitXor();
    while (this.isPunct('|')) { this.next(); v = v | this.parseBitXor(); }
    return v;
  }
  private parseBitXor(): number {
    let v = this.parseBitAnd();
    while (this.isPunct('^')) { this.next(); v = v ^ this.parseBitAnd(); }
    return v;
  }
  private parseBitAnd(): number {
    let v = this.parseEquality();
    while (this.isPunct('&')) { this.next(); v = v & this.parseEquality(); }
    return v;
  }
  private parseEquality(): number {
    let v = this.parseRelational();
    while (this.isPunct('==') || this.isPunct('!=')) {
      const op = this.next().text;
      const r = this.parseRelational();
      v = op === '==' ? (v === r ? 1 : 0) : (v !== r ? 1 : 0);
    }
    return v;
  }
  private parseRelational(): number {
    let v = this.parseShift();
    while (this.isPunct('<') || this.isPunct('>') || this.isPunct('<=') || this.isPunct('>=')) {
      const op = this.next().text;
      const r = this.parseShift();
      v = op === '<' ? (v < r ? 1 : 0) : op === '>' ? (v > r ? 1 : 0) : op === '<=' ? (v <= r ? 1 : 0) : (v >= r ? 1 : 0);
    }
    return v;
  }
  private parseShift(): number {
    let v = this.parseAdditive();
    while (this.isPunct('<<') || this.isPunct('>>')) {
      const op = this.next().text;
      const r = this.parseAdditive();
      v = op === '<<' ? v << r : v >> r;
    }
    return v;
  }
  private parseAdditive(): number {
    let v = this.parseMultiplicative();
    while (this.isPunct('+') || this.isPunct('-')) {
      const op = this.next().text;
      const r = this.parseMultiplicative();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  private parseMultiplicative(): number {
    let v = this.parseUnary();
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('%')) {
      const op = this.next().text;
      const r = this.parseUnary();
      if ((op === '/' || op === '%') && r === 0) throw new PreprocessorError('division by zero in #if', this.file, this.lineNo);
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  }
  private parseUnary(): number {
    if (this.isPunct('!')) { this.next(); return this.parseUnary() === 0 ? 1 : 0; }
    if (this.isPunct('-')) { this.next(); return -this.parseUnary(); }
    if (this.isPunct('+')) { this.next(); return this.parseUnary(); }
    if (this.isPunct('~')) { this.next(); return ~this.parseUnary(); }
    return this.parsePrimary();
  }
  private parsePrimary(): number {
    if (this.isPunct('(')) {
      this.next();
      const v = this.parseExpr();
      if (!this.isPunct(')')) throw new PreprocessorError("expected ')' in #if", this.file, this.lineNo);
      this.next();
      return v;
    }
    const t = this.next();
    if (t.kind === 'num') {
      const text = t.text.replace(/[uUlL]+$/, '');
      return text.startsWith('0x') || text.startsWith('0X') ? parseInt(text, 16) : parseInt(text, 10);
    }
    if (t.kind === 'char') return t.value.charCodeAt(0);
    throw new PreprocessorError(`unexpected token '${t.text}' in #if expression`, this.file, this.lineNo);
  }
}
