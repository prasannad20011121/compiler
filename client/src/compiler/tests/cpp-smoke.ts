import { compileProgram } from '../driver';

let ok = true;
function check(cond: boolean, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}

async function runProgram(src: string): Promise<{ stdout: string }> {
  const result = compileProgram([{ path: 'main.cpp', content: src }], 'main.cpp');
  if (!result.ok) throw new Error('compile failed:\n' + result.errors.join('\n'));

  let stdout = '';
  let memory: WebAssembly.Memory;
  const stdoutDecoder = new TextDecoder();
  const module = await WebAssembly.compile(new Uint8Array(result.wasm));
  const instance = await WebAssembly.instantiate(module, {
    env: {
      write: (fd: number, ptr: number, len: number) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (fd === 1 || fd === 2) stdout += stdoutDecoder.decode(bytes, { stream: true });
        return len;
      },
      read: () => 0,
      exit: (code: number) => {
        throw new Error(`__exit__${code}`);
      },
    },
  });
  memory = instance.exports['memory'] as WebAssembly.Memory;
  (instance.exports['main'] as () => number)();
  return { stdout };
}

async function run() {
  // 1. class with fields, constructor (incl. member-init list), and methods using implicit `this`
  {
    const { stdout } = await runProgram(`
      #include <stdio.h>
      class Point {
      public:
        int x, y;
        Point(int px, int py) : x(px), y(py) {}
        int sum() { return x + y; }
        void scale(int f) { x = x * f; y = y * f; }
      };
      int main(void) {
        Point p(3, 4);
        printf("sum=%d\\n", p.sum());
        p.scale(2);
        printf("scaled sum=%d\\n", p.sum());
        return 0;
      }
    `);
    check(stdout.includes('sum=7'), `constructor + member-init list + method: ${JSON.stringify(stdout)}`);
    check(stdout.includes('scaled sum=14'), `method mutating fields via implicit this: ${JSON.stringify(stdout)}`);
  }

  // 2. new/delete with constructor/destructor, and a method calling another method without `this->`
  {
    const { stdout } = await runProgram(`
      #include <stdio.h>
      class Counter {
      public:
        int value;
        Counter() { value = 0; printf("ctor\\n"); }
        ~Counter() { printf("dtor value=%d\\n", value); }
        void bump() { value = value + 1; }
        void bumpTwice() { bump(); bump(); }
      };
      int main(void) {
        Counter *c = new Counter();
        c->bumpTwice();
        printf("value=%d\\n", c->value);
        delete c;
        return 0;
      }
    `);
    check(stdout.includes('ctor'), `default ctor via new: ${JSON.stringify(stdout)}`);
    check(stdout.includes('value=2'), `implicit-this method-to-method call: ${JSON.stringify(stdout)}`);
    check(stdout.includes('dtor value=2'), `destructor invoked by delete: ${JSON.stringify(stdout)}`);
  }

  // 3. stack-allocated object with auto-default-construction
  {
    const { stdout } = await runProgram(`
      #include <stdio.h>
      struct Accumulator {
        int total;
        Accumulator() { total = 100; }
        void add(int v) { total = total + v; }
      };
      int main(void) {
        Accumulator a;
        a.add(5);
        a.add(10);
        printf("total=%d\\n", a.total);
        return 0;
      }
    `);
    check(stdout.includes('total=115'), `auto-default-constructed stack object: ${JSON.stringify(stdout)}`);
  }

  if (!ok) throw new Error('cpp smoke test failed');
  console.log('ALL PASS');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
