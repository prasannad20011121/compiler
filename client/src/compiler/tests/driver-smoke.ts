import { compileProgram } from '../driver';

let ok = true;
function check(cond: boolean, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}

async function runProgram(src: string, stdin = ''): Promise<{ stdout: string; exitCode: number | null }> {
  const result = compileProgram([{ path: 'main.c', content: src }], 'main.c');
  if (!result.ok) throw new Error('compile failed:\n' + result.errors.join('\n'));

  let stdout = '';
  let stdoutBytes: Uint8Array = new Uint8Array(0);
  let exitCode: number | null = null;
  let memory: WebAssembly.Memory;
  let stdinPos = 0;
  const stdinBytes = new TextEncoder().encode(stdin);

  const { instance } = await WebAssembly.instantiate(result.wasm, {
    env: {
      write: (fd: number, ptr: number, len: number) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (fd === 1 || fd === 2) stdout += new TextDecoder().decode(bytes);
        void stdoutBytes;
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
  memory = instance.exports.memory as WebAssembly.Memory;
  try {
    (instance.exports.main as Function)();
  } catch (e: any) {
    if (e.message !== '__exit__') throw e;
  }
  return { stdout, exitCode };
}

async function run() {
  // 1. printf: integers, strings, chars, width/padding, hex, floats
  {
    const { stdout } = await runProgram(`
      int main(void) {
        printf("hello, %s! you are %d years old\\n", "world", 30);
        printf("[%5d][%-5d][%05d]\\n", 42, 42, 42);
        printf("hex: %x %X, char: %c\\n", 255, 255, 'Z');
        printf("float: %.2f\\n", 3.14159);
        return 0;
      }
    `);
    check(stdout.includes('hello, world! you are 30 years old'), `basic printf: ${JSON.stringify(stdout)}`);
    check(stdout.includes('[   42][42   ][00042]'), `width/pad printf: ${JSON.stringify(stdout)}`);
    check(stdout.includes('hex: ff FF, char: Z'), `hex/char printf: ${JSON.stringify(stdout)}`);
    check(stdout.includes('float: 3.14'), `float printf: ${JSON.stringify(stdout)}`);
  }

  // 2. malloc/free + a dynamically-built linked list, freeing along the way
  {
    const { stdout } = await runProgram(`
      struct Node { int val; struct Node *next; };
      struct Node *push(struct Node *head, int v) {
        struct Node *n = (struct Node *)malloc(sizeof(struct Node));
        n->val = v;
        n->next = head;
        return n;
      }
      int main(void) {
        struct Node *head = 0;
        for (int i = 1; i <= 5; i = i + 1) head = push(head, i);
        int sum = 0;
        struct Node *cur = head;
        while (cur != 0) {
          sum = sum + cur->val;
          struct Node *next = cur->next;
          free(cur);
          cur = next;
        }
        printf("sum=%d\\n", sum);
        return 0;
      }
    `);
    check(stdout.trim() === 'sum=15', `malloc/free linked list: ${JSON.stringify(stdout)}`);
  }

  // 3. string.h round trip
  {
    const { stdout } = await runProgram(`
      int main(void) {
        char buf[64];
        strcpy(buf, "Hello, ");
        strcat(buf, "Compiler!");
        printf("%s (len=%d)\\n", buf, (int)strlen(buf));
        printf("cmp=%d\\n", strcmp("abc", "abd"));
        return 0;
      }
    `);
    check(stdout.includes('Hello, Compiler! (len=16)'), `strcpy/strcat/strlen: ${JSON.stringify(stdout)}`);
    check(stdout.includes('cmp=-1'), `strcmp: ${JSON.stringify(stdout)}`);
  }

  // 4. recursion + big-ish allocation stress (quicksort over a malloc'd array)
  {
    const { stdout } = await runProgram(`
      void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
      void quicksort(int *arr, int lo, int hi) {
        if (lo >= hi) return;
        int pivot = arr[hi];
        int i = lo - 1;
        for (int j = lo; j < hi; j = j + 1) {
          if (arr[j] < pivot) { i = i + 1; swap(&arr[i], &arr[j]); }
        }
        swap(&arr[i + 1], &arr[hi]);
        int p = i + 1;
        quicksort(arr, lo, p - 1);
        quicksort(arr, p + 1, hi);
      }
      int main(void) {
        int n = 8;
        int *arr = (int *)malloc(sizeof(int) * n);
        int vals[8] = {5, 3, 8, 1, 9, 2, 7, 4};
        for (int i = 0; i < n; i = i + 1) arr[i] = vals[i];
        quicksort(arr, 0, n - 1);
        for (int i = 0; i < n; i = i + 1) printf("%d ", arr[i]);
        printf("\\n");
        return 0;
      }
    `);
    check(stdout.trim() === '1 2 3 4 5 7 8 9', `quicksort: ${JSON.stringify(stdout)}`);
  }

  // 5. stdin via scanf/getchar
  {
    const { stdout } = await runProgram(
      `
      int main(void) {
        int a, b;
        scanf("%d %d", &a, &b);
        printf("sum=%d\\n", a + b);
        return 0;
      }
    `,
      '12 30\n',
    );
    check(stdout.trim() === 'sum=42', `scanf: ${JSON.stringify(stdout)}`);
  }

  // 6. exit() via the host import
  {
    const { stdout, exitCode } = await runProgram(`
      int main(void) {
        printf("before\\n");
        exit(7);
        printf("after\\n");
        return 0;
      }
    `);
    check(stdout.trim() === 'before', `exit() stops execution: ${JSON.stringify(stdout)}`);
    check(exitCode === 7, `exit code propagated: ${exitCode}`);
  }

  if (!ok) throw new Error('driver smoke test failed');
  console.log('ALL PASS');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
