/// <reference lib="webworker" />
/**
 * JS/TS execution worker. Runs entirely in the user's browser:
 * builds an ES-module graph from the workspace snapshot, transpiles
 * TypeScript in-memory, rewrites relative imports to blob: URLs, and
 * dynamically imports the entry module. No network, no server.
 */
import ts from 'typescript';

interface RunRequest {
  type: 'run';
  entry: string;
  files: { path: string; content: string }[];
}

type RunnerMessage =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'done'; ok: boolean; ms: number };

const post = (message: RunnerMessage) => self.postMessage(message);

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'function') return String(value);
  if (value instanceof Map) return `Map(${value.size}) ${JSON.stringify([...value.entries()])}`;
  if (value instanceof Set) return `Set(${value.size}) ${JSON.stringify([...value.values()])}`;
  try {
    return JSON.stringify(value, null, value && typeof value === 'object' ? 1 : 0) ?? String(value);
  } catch {
    return String(value);
  }
}

function hookConsole(): void {
  const emit =
    (stream: 'stdout' | 'stderr') =>
    (...args: unknown[]) =>
      post({ type: stream, text: args.map(formatArg).join(' ') + '\n' });
  console.log = emit('stdout');
  console.info = emit('stdout');
  console.debug = emit('stdout');
  console.warn = emit('stderr');
  console.error = emit('stderr');
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

class ModuleGraph {
  private readonly urls = new Map<string, string>();
  private readonly building = new Set<string>();

  constructor(private readonly files: Map<string, string>) {}

  resolve(specifier: string, importer: string): string {
    const base = normalize(importer.split('/').slice(0, -1).join('/') + '/' + specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`]) {
      if (this.files.has(candidate)) return candidate;
    }
    throw new Error(`Cannot resolve import '${specifier}' from ${importer}`);
  }

  urlFor(path: string): string {
    const cached = this.urls.get(path);
    if (cached) return cached;
    if (this.building.has(path)) {
      throw new Error(`Circular import involving ${path} is not supported`);
    }
    this.building.add(path);

    let source = this.files.get(path);
    if (source === undefined) throw new Error(`File not found: ${path}`);

    if (path.endsWith('.ts')) {
      source = ts.transpileModule(source, {
        fileName: path,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true, // keep imports even if they look unused
          sourceMap: false,
        },
      }).outputText;
    }

    // Rewrite relative import specifiers to blob: URLs, back to front so spans stay valid.
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (let i = imports.length - 1; i >= 0; i--) {
      const { fileName: specifier, pos, end } = imports[i];
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const url = this.urlFor(this.resolve(specifier, path));
        // preProcessFile spans: pos = opening quote, end = pos + specifier.length,
        // so the full quoted literal occupies [pos, end + 2).
        if (source.slice(pos + 1, end + 1) !== specifier) {
          throw new Error(`Failed to rewrite import '${specifier}' in ${path}`);
        }
        source = source.slice(0, pos) + JSON.stringify(url) + source.slice(end + 2);
      } else if (!specifier.startsWith('blob:')) {
        throw new Error(
          `'${specifier}' imported by ${path}: npm packages are not supported yet — only relative imports between workspace files.`,
        );
      }
    }

    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    this.urls.set(path, url);
    this.building.delete(path);
    return url;
  }
}

self.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { entry, files } = event.data;
  const started = performance.now();
  hookConsole();

  self.onunhandledrejection = (e: PromiseRejectionEvent) => {
    post({ type: 'stderr', text: formatArg(e.reason) + '\n' });
  };

  try {
    const graph = new ModuleGraph(new Map(files.map((f) => [f.path, f.content])));
    await import(/* @vite-ignore */ graph.urlFor(normalize(entry)));
    post({ type: 'done', ok: true, ms: performance.now() - started });
  } catch (error) {
    post({ type: 'stderr', text: formatArg(error) + '\n' });
    post({ type: 'done', ok: false, ms: performance.now() - started });
  }
};
