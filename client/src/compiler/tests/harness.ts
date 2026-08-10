import { compileProgram, type SourceFile } from '../driver';

export let pass = 0;
export let fail = 0;
export const failures: string[] = [];

export function check(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS: ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

export async function runFiles(files: SourceFile[], entry: string, stdin = ''): Promise<{ stdout: string; exitCode: number }> {
  const result = compileProgram(files, entry);
  if (!result.ok) throw new Error(`compile failed:\n${result.errors.join('\n')}`);

  let stdout = '';
  let memory: WebAssembly.Memory;
  let stdinPos = 0;
  const stdinBytes = new TextEncoder().encode(stdin);
  const dec = new TextDecoder();
  let exitCode = 0;

  const module = await WebAssembly.compile(new Uint8Array(result.wasm));
  const instance = await WebAssembly.instantiate(module, {
    env: {
      write: (fd: number, ptr: number, len: number) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (fd === 1 || fd === 2) stdout += dec.decode(bytes, { stream: true });
        return len;
      },
      read: (_fd: number, ptr: number, maxlen: number) => {
        const n = Math.min(maxlen, stdinBytes.length - stdinPos);
        if (n <= 0) return 0;
        new Uint8Array(memory.buffer, ptr, n).set(stdinBytes.subarray(stdinPos, stdinPos + n));
        stdinPos += n;
        return n;
      },
      exit: (code: number) => {
        exitCode = code;
        throw new Error('__exit__');
      },
    },
  });
  memory = instance.exports['memory'] as WebAssembly.Memory;
  try {
    const rc = (instance.exports['main'] as () => number)();
    if (typeof rc === 'number') exitCode = rc;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__exit__') throw e;
  }
  return { stdout, exitCode };
}

export function single(content: string): SourceFile[] {
  return [{ path: 'main.c', content }];
}
export function singleCpp(content: string): SourceFile[] {
  return [{ path: 'main.cpp', content }];
}

export interface Case {
  name: string;
  files: SourceFile[];
  entry: string;
  stdin?: string;
  check: (out: { stdout: string; exitCode: number }) => void;
}

export async function runBattery(cases: Case[]): Promise<void> {
  console.log(`Running ${cases.length} programs...\n`);
  for (const c of cases) {
    try {
      const result = await runFiles(c.files, c.entry, c.stdin);
      c.check(result);
    } catch (e) {
      fail++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${c.name} — threw: ${msg}`);
      console.log(`FAIL: ${c.name} — threw: ${msg}`);
    }
  }
  console.log(`\n${pass}/${cases.length} passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    throw new Error(`${fail} program(s) failed`);
  }
  console.log('ALL PASS');
}
