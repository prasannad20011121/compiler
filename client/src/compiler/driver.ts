import { Preprocessor, type FileResolver } from './preprocessor';
import { Parser, ParseError } from './parser';
import { LexError } from './lexer';
import { CodeGenerator, CodegenError } from './codegen';
import { Types, functionType, pointerTo } from './types';
import type { TopDecl } from './ast';
import { LIBC_SOURCE } from './runtime/libc';

export interface SourceFile {
  path: string;
  content: string;
}

export type CompileResult = { ok: true; wasm: Uint8Array } | { ok: false; errors: string[] };

function isCSource(path: string): boolean {
  return /\.(c)$/i.test(path);
}
function isCppSource(path: string): boolean {
  return /\.(cc|cpp|cxx|c\+\+)$/i.test(path);
}
function isHeader(path: string): boolean {
  return /\.(h|hh|hpp|hxx)$/i.test(path);
}

function makeResolver(files: SourceFile[]): FileResolver {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const resolveAgainst = (spec: string, fromFile: string) => {
    if (byPath.has(spec)) return { path: spec, text: byPath.get(spec)! };
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/') + 1) : '';
    const joined = normalizePath(dir + spec);
    if (byPath.has(joined)) return { path: joined, text: byPath.get(joined)! };
    const bare = spec.split('/').pop()!;
    const match = files.find((f) => f.path.split('/').pop() === bare);
    return match ? { path: match.path, text: match.content } : undefined;
  };
  return {
    resolveQuoted: (spec, fromFile) => resolveAgainst(spec, fromFile),
    resolveAngle: () => undefined, // system headers are no-ops: runtime symbols are always pre-declared
  };
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Compiles a whole program (all translation units + our runtime) into a single WASM module. No linker: everything is parsed and code-generated together, so cross-file calls just work. */
export function compileProgram(files: SourceFile[], entryPath: string): CompileResult {
  const cpp = isCppSource(entryPath);
  const resolver = makeResolver(files);
  const errors: string[] = [];

  const units: { path: string; decls: TopDecl[] }[] = [];
  const addUnit = (path: string, source: string) => {
    try {
      const pp = new Preprocessor(resolver, {
        __STDC__: '1',
        __wasm__: '1',
        [cpp ? '__cplusplus' : '__STRICT_ANSI__']: '1',
      });
      const toks = pp.preprocessFile(source, path);
      const parser = new Parser(toks, cpp);
      units.push({ path, decls: parser.parseTranslationUnit() });
    } catch (e) {
      errors.push(describeError(e));
    }
  };

  addUnit('<runtime>/libc.c', LIBC_SOURCE);
  for (const f of files) {
    if (isCSource(f.path) || isCppSource(f.path)) addUnit(f.path, f.content);
    void isHeader; // headers are only reached via #include, never compiled directly
  }

  if (errors.length > 0) return { ok: false, errors };

  const cg = new CodeGenerator();
  cg.importFunction('env', 'write', '__builtin_write', functionType([Types.int, pointerTo(Types.void), Types.int], Types.int, false));
  cg.importFunction('env', 'read', '__builtin_read', functionType([Types.int, pointerTo(Types.void), Types.int], Types.int, false));
  cg.importFunction('env', 'exit', '__builtin_exit', functionType([Types.int], Types.void, false));

  try {
    for (const u of units) for (const d of u.decls) if (d.kind === 'FunctionDecl') cg.registerFunction(d.name, d.type, !!d.body);
    for (const u of units) for (const d of u.decls) if (d.kind === 'VarDecl') cg.declareGlobalVar(d);
    cg.allocateRuntimeGlobals();
    for (const u of units) {
      for (const d of u.decls) {
        if (d.kind === 'FunctionDecl' && d.body) {
          try {
            cg.compileFunction(d);
          } catch (e) {
            errors.push(describeError(e, u.path));
          }
        }
      }
    }
  } catch (e) {
    errors.push(describeError(e));
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!cg.hasGlobal('main')) {
    return { ok: false, errors: [`${entryPath}: no 'main' function found`] };
  }

  cg.finalizeMemoryLayout();
  cg.exportEntry('main');
  return { ok: true, wasm: cg.finishModule() };
}

function describeError(e: unknown, fallbackFile?: string): string {
  if (e instanceof ParseError || e instanceof LexError || e instanceof CodegenError) return e.message;
  if (e instanceof Error) return fallbackFile ? `${fallbackFile}: ${e.message}` : e.message;
  return String(e);
}
