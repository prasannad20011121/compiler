import { Preprocessor, type FileResolver } from '../preprocessor';
import { Parser } from '../parser';
import { CodeGenerator } from '../codegen';
import { Types, functionType, pointerTo } from '../types';
import type { TopDecl } from '../ast';

const resolver: FileResolver = { resolveQuoted: () => undefined, resolveAngle: () => undefined };

let ok = true;
function check(cond: boolean, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}

async function compileAndRun(src: string): Promise<{ output: string[]; instance: WebAssembly.Instance; mem: WebAssembly.Memory }> {
  const pp = new Preprocessor(resolver);
  const toks = pp.preprocessFile(src, 't.c');
  const parser = new Parser(toks);
  const decls: TopDecl[] = parser.parseTranslationUnit();

  const cg = new CodeGenerator();
  cg.importFunction('env', 'print_i32', 'print_i32', functionType([Types.int], Types.void, false));
  cg.importFunction('env', 'print_str', 'print_str', functionType([pointerTo(Types.char)], Types.void, false));
  cg.importFunction('env', 'print_f64', 'print_f64', functionType([Types.double], Types.void, false));

  for (const d of decls) if (d.kind === 'FunctionDecl') cg.registerFunction(d.name, d.type, !!d.body);
  for (const d of decls) if (d.kind === 'VarDecl') cg.declareGlobalVar(d);
  cg.allocateRuntimeGlobals();
  for (const d of decls) if (d.kind === 'FunctionDecl' && d.body) cg.compileFunction(d);
  cg.finalizeMemoryLayout();
  cg.exportEntry('main');
  const bytes = cg.finishModule();

  const output: string[] = [];
  let instanceRef: WebAssembly.Instance;
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      print_i32: (v: number) => output.push(String(v)),
      print_f64: (v: number) => output.push(String(v)),
      print_str: (ptr: number) => {
        const mem = new Uint8Array((instanceRef.exports.memory as WebAssembly.Memory).buffer);
        let end = ptr;
        while (mem[end] !== 0) end++;
        output.push(new TextDecoder().decode(mem.slice(ptr, end)));
      },
    },
  });
  instanceRef = instance;
  return { output, instance, mem: instance.exports.memory as WebAssembly.Memory };
}

async function run() {
  // 1. constant + arithmetic
  {
    const { instance } = await compileAndRun(`int main(void) { return 6 * 7; }`);
    const r = (instance.exports.main as Function)();
    check(r === 42, `arithmetic: 6*7 = ${r}`);
  }

  // 2. if/else + while + for + unary negation (regression test for the sub-order bug)
  {
    const { instance } = await compileAndRun(`
      int main(void) {
        int x = -5;
        int sum = 0;
        int i = 0;
        while (i < 10) { sum = sum + i; i = i + 1; }
        for (int j = 0; j < 5; j = j + 1) { sum = sum + j; }
        if (x < 0) { sum = sum - x; } else { sum = sum + x; }
        return sum;
      }
    `);
    const r = (instance.exports.main as Function)();
    // sum(0..9)=45, sum(0..4)=10, plus -x(=5) => 45+10+5=60
    check(r === 60, `control flow + negation: got ${r}, want 60`);
  }

  // 3. recursion (fibonacci) — exercises calls + params
  {
    const { instance } = await compileAndRun(`
      int fib(int n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
      }
      int main(void) { return fib(10); }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 55, `recursive fib(10) = ${r}, want 55`);
  }

  // 4. pointers + arrays + address-of/deref
  {
    const { instance } = await compileAndRun(`
      void inc(int *p) { *p = *p + 1; }
      int main(void) {
        int arr[5];
        for (int i = 0; i < 5; i = i + 1) arr[i] = i * i;
        int x = 10;
        inc(&x);
        return arr[3] + x;
      }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 9 + 11, `pointers/arrays: got ${r}, want 20`);
  }

  // 5. structs, including a self-referential linked list summed via pointer traversal
  {
    const { instance } = await compileAndRun(`
      struct Node { int val; struct Node *next; };
      int sum_list(struct Node *head) {
        int total = 0;
        struct Node *cur = head;
        while (cur != 0) {
          total = total + cur->val;
          cur = cur->next;
        }
        return total;
      }
      int main(void) {
        struct Node c; c.val = 3; c.next = 0;
        struct Node b; b.val = 2; b.next = &c;
        struct Node a; a.val = 1; a.next = &b;
        return sum_list(&a);
      }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 6, `linked list traversal: got ${r}, want 6`);
  }

  // 6. global variables + strings via imported print
  {
    const { instance, output } = await compileAndRun(`
      int counter = 100;
      void bump(void) { counter = counter + 1; print_i32(counter); }
      int main(void) {
        print_str("hello");
        bump();
        bump();
        return counter;
      }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 102, `globals: got ${r}, want 102`);
    check(output.join(',') === 'hello,101,102', `global + string output: ${output.join(',')}`);
  }

  // 7. switch with fallthrough + default, ternary, compound assignment, post/pre inc
  {
    const { instance } = await compileAndRun(`
      int classify(int x) {
        int r = 0;
        switch (x) {
          case 1:
          case 2:
            r = 10;
            break;
          case 3:
            r = 20;
            break;
          default:
            r = -1;
        }
        return r;
      }
      int main(void) {
        int a = classify(2);
        int b = classify(3);
        int c = classify(99);
        int x = 5;
        x += 3;
        int y = x++;
        int z = ++x;
        int t = a > b ? a : b;
        return a * 1000 + b * 100 + c + (x - y - z) + t;
      }
    `);
    const r = (instance.exports.main as Function)();
    // a=10,b=20,c=-1; x starts 5 -> +=3 -> 8; y=x++ => y=8, x=9; z=++x => x=10, z=10
    // (x - y - z) = 10-8-10 = -8 ; t = max(a,b)=20
    check(r === 10000 + 2000 - 1 - 8 + 20, `switch/ternary/inc-dec: got ${r}`);
  }

  // 8. floats/doubles
  {
    const { instance } = await compileAndRun(`
      double avg(double a, double b) { return (a + b) / 2.0; }
      int main(void) {
        double r = avg(3.0, 7.0);
        return (int)r;
      }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 5, `float arithmetic: avg(3,7)=${r}, want 5`);
  }

  // 9. logical operators short-circuit + comma operator
  {
    const { instance } = await compileAndRun(`
      int calls = 0;
      int sideEffect(void) { calls = calls + 1; return 1; }
      int main(void) {
        int x = 0 && sideEffect();
        int y = 1 || sideEffect();
        int z = (1, 2, 3);
        return calls * 100 + x * 10 + y + z;
      }
    `);
    const r = (instance.exports.main as Function)();
    check(r === 0 + 0 + 1 + 3, `short-circuit/comma: got ${r}, want 4 (calls should stay 0)`);
  }

  if (!ok) throw new Error('codegen smoke test failed');
  console.log('ALL PASS');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
