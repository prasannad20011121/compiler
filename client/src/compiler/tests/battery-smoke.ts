/**
 * A battery of 25+ real programs — C and C++, single-file and multi-file,
 * simple through fairly advanced — compiled with our own compiler and
 * executed as real WASM, checking actual output (not just "it compiled").
 */
import { compileProgram, type SourceFile } from '../driver';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS: ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runFiles(files: SourceFile[], entry: string, stdin = ''): Promise<{ stdout: string; exitCode: number }> {
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

function single(content: string): SourceFile[] {
  return [{ path: 'main.c', content }];
}
function singleCpp(content: string): SourceFile[] {
  return [{ path: 'main.cpp', content }];
}

interface Case {
  name: string;
  files: SourceFile[];
  entry: string;
  stdin?: string;
  check: (out: { stdout: string; exitCode: number }) => void;
}

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

// ============================== C: simple (1-9) ==============================

add({
  name: 'C1 hello world',
  files: single(`#include <stdio.h>\nint main(void) { printf("Hello, World!\\n"); return 0; }`),
  entry: 'main.c',
  check: (r) => check(r.stdout === 'Hello, World!\n', 'C1 hello world', r.stdout),
});

add({
  name: 'C2 arithmetic operators',
  files: single(`#include <stdio.h>
int main(void) {
  int a = 17, b = 5;
  printf("%d %d %d %d %d\\n", a + b, a - b, a * b, a / b, a % b);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '22 12 85 3 2\n', 'C2 arithmetic operators', r.stdout),
});

add({
  name: 'C3 FizzBuzz',
  files: single(`#include <stdio.h>
int main(void) {
  for (int i = 1; i <= 15; i = i + 1) {
    if (i % 15 == 0) printf("FizzBuzz\\n");
    else if (i % 3 == 0) printf("Fizz\\n");
    else if (i % 5 == 0) printf("Buzz\\n");
    else printf("%d\\n", i);
  }
  return 0;
}`),
  entry: 'main.c',
  check: (r) => {
    const expected = '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n';
    check(r.stdout === expected, 'C3 FizzBuzz', r.stdout);
  },
});

add({
  name: 'C4 recursive factorial',
  files: single(`#include <stdio.h>
long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
int main(void) { printf("%ld\\n", fact(10)); return 0; }`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '3628800', 'C4 recursive factorial', r.stdout),
});

add({
  name: 'C5 iterative fibonacci sequence',
  files: single(`#include <stdio.h>
int main(void) {
  int a = 0, b = 1;
  for (int i = 0; i < 10; i = i + 1) {
    printf("%d ", a);
    int next = a + b;
    a = b;
    b = next;
  }
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '0 1 1 2 3 5 8 13 21 34 \n', 'C5 iterative fibonacci', r.stdout),
});

add({
  name: 'C6 sieve of Eratosthenes',
  files: single(`#include <stdio.h>
int main(void) {
  int isComposite[31];
  for (int i = 0; i <= 30; i = i + 1) isComposite[i] = 0;
  for (int p = 2; p * p <= 30; p = p + 1) {
    if (!isComposite[p]) {
      for (int m = p * p; m <= 30; m = m + p) isComposite[m] = 1;
    }
  }
  for (int i = 2; i <= 30; i = i + 1) if (!isComposite[i]) printf("%d ", i);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '2 3 5 7 11 13 17 19 23 29 \n', 'C6 sieve of Eratosthenes', r.stdout),
});

add({
  name: 'C7 array sum and average',
  files: single(`#include <stdio.h>
int main(void) {
  int nums[6] = {4, 8, 15, 16, 23, 42};
  int sum = 0;
  for (int i = 0; i < 6; i = i + 1) sum = sum + nums[i];
  double avg = (double)sum / 6.0;
  printf("sum=%d avg=%.2f\\n", sum, avg);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'sum=108 avg=18.00', 'C7 array sum/average', r.stdout),
});

add({
  name: 'C8 in-place string reverse',
  files: single(`#include <stdio.h>
#include <string.h>
void reverse(char *s) {
  int i = 0, j = (int)strlen(s) - 1;
  while (i < j) {
    char t = s[i]; s[i] = s[j]; s[j] = t;
    i = i + 1; j = j - 1;
  }
}
int main(void) {
  char buf[32];
  strcpy(buf, "Hello, Compiler!");
  reverse(buf);
  printf("%s\\n", buf);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '!relipmoC ,olleH', 'C8 in-place string reverse', r.stdout),
});

add({
  name: 'C9 bubble sort',
  files: single(`#include <stdio.h>
void bubble_sort(int *a, int n) {
  for (int i = 0; i < n - 1; i = i + 1) {
    for (int j = 0; j < n - 1 - i; j = j + 1) {
      if (a[j] > a[j + 1]) {
        int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
      }
    }
  }
}
int main(void) {
  int a[8] = {5, 3, 8, 1, 9, 2, 7, 4};
  bubble_sort(a, 8);
  for (int i = 0; i < 8; i = i + 1) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 2 3 4 5 7 8 9 \n', 'C9 bubble sort', r.stdout),
});

// ============================== C: medium/hard (10-17) ==============================

add({
  name: 'C10 Point distance via hand-rolled Newton sqrt',
  files: single(`#include <stdio.h>
struct Point { double x, y; };
double my_sqrt(double v) {
  double guess = v > 1.0 ? v / 2.0 : 1.0;
  for (int i = 0; i < 30; i = i + 1) guess = 0.5 * (guess + v / guess);
  return guess;
}
double dist(struct Point a, struct Point b) {
  double dx = a.x - b.x, dy = a.y - b.y;
  return my_sqrt(dx * dx + dy * dy);
}
int main(void) {
  struct Point a; a.x = 0; a.y = 0;
  struct Point b; b.x = 3; b.y = 4;
  printf("%.4f\\n", dist(a, b));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '5.0000', 'C10 struct-by-value + Newton sqrt', r.stdout),
});

add({
  name: 'C11 singly linked list insert-at-tail + sum',
  files: single(`#include <stdio.h>
#include <stdlib.h>
struct Node { int val; struct Node *next; };
struct Node *append(struct Node *head, int v) {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  n->val = v; n->next = 0;
  if (!head) return n;
  struct Node *cur = head;
  while (cur->next) cur = cur->next;
  cur->next = n;
  return head;
}
int main(void) {
  struct Node *head = 0;
  for (int i = 1; i <= 6; i = i + 1) head = append(head, i * i);
  int sum = 0;
  for (struct Node *c = head; c; c = c->next) { printf("%d ", c->val); sum = sum + c->val; }
  printf("\\nsum=%d\\n", sum);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 4 9 16 25 36 \nsum=91\n', 'C11 linked list append + sum', r.stdout),
});

add({
  name: 'C12 binary search tree insert + inorder traversal',
  files: single(`#include <stdio.h>
#include <stdlib.h>
struct TreeNode { int val; struct TreeNode *left; struct TreeNode *right; };
struct TreeNode *insert(struct TreeNode *root, int v) {
  if (!root) {
    struct TreeNode *n = (struct TreeNode *)malloc(sizeof(struct TreeNode));
    n->val = v; n->left = 0; n->right = 0;
    return n;
  }
  if (v < root->val) root->left = insert(root->left, v);
  else root->right = insert(root->right, v);
  return root;
}
void inorder(struct TreeNode *root) {
  if (!root) return;
  inorder(root->left);
  printf("%d ", root->val);
  inorder(root->right);
}
int main(void) {
  struct TreeNode *root = 0;
  int vals[7] = {5, 3, 8, 1, 4, 7, 9};
  for (int i = 0; i < 7; i = i + 1) root = insert(root, vals[i]);
  inorder(root);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 3 4 5 7 8 9 \n', 'C12 BST insert + inorder', r.stdout),
});

add({
  name: 'C13 2x2 matrix multiplication',
  files: single(`#include <stdio.h>
int main(void) {
  int A[2][2] = {{1, 2}, {3, 4}};
  int B[2][2] = {{5, 6}, {7, 8}};
  int C[2][2];
  for (int i = 0; i < 2; i = i + 1) {
    for (int j = 0; j < 2; j = j + 1) {
      int sum = 0;
      for (int k = 0; k < 2; k = k + 1) sum = sum + A[i][k] * B[k][j];
      C[i][j] = sum;
    }
  }
  printf("%d %d %d %d\\n", C[0][0], C[0][1], C[1][0], C[1][1]);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '19 22 43 50', 'C13 2x2 matrix multiply', r.stdout),
});

add({
  name: 'C14 word count via manual scan',
  files: single(`#include <stdio.h>
int count_words(const char *s) {
  int count = 0, inWord = 0;
  for (int i = 0; s[i]; i = i + 1) {
    if (s[i] != ' ') {
      if (!inWord) { count = count + 1; inWord = 1; }
    } else {
      inWord = 0;
    }
  }
  return count;
}
int main(void) {
  printf("%d\\n", count_words("the quick brown fox jumps"));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '5', 'C14 word count', r.stdout),
});

add({
  name: 'C15 postfix expression evaluator',
  files: single(`#include <stdio.h>
int main(void) {
  char *expr = "23+4*";
  int stack[16];
  int sp = 0;
  for (int i = 0; expr[i]; i = i + 1) {
    char c = expr[i];
    if (c >= '0' && c <= '9') {
      stack[sp] = c - '0';
      sp = sp + 1;
    } else {
      int b = stack[sp - 1]; sp = sp - 1;
      int a = stack[sp - 1]; sp = sp - 1;
      int r;
      if (c == '+') r = a + b;
      else if (c == '-') r = a - b;
      else if (c == '*') r = a * b;
      else r = a / b;
      stack[sp] = r; sp = sp + 1;
    }
  }
  printf("%d\\n", stack[0]);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '20', 'C15 postfix evaluator ((2+3)*4)', r.stdout),
});

add({
  name: 'C16 dynamic array via realloc',
  files: single(`#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int cap = 2, len = 0;
  int *arr = (int *)malloc(sizeof(int) * cap);
  for (int i = 1; i <= 10; i = i + 1) {
    if (len == cap) {
      cap = cap * 2;
      arr = (int *)realloc(arr, sizeof(int) * cap);
    }
    arr[len] = i;
    len = len + 1;
  }
  int sum = 0;
  for (int i = 0; i < len; i = i + 1) sum = sum + arr[i];
  printf("len=%d cap=%d sum=%d\\n", len, cap, sum);
  free(arr);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'len=10 cap=16 sum=55', 'C16 dynamic array via realloc', r.stdout),
});

add({
  name: 'C17 recursive merge sort',
  files: single(`#include <stdio.h>
#include <stdlib.h>
void merge(int *a, int lo, int mid, int hi) {
  int n = hi - lo + 1;
  int *tmp = (int *)malloc(sizeof(int) * n);
  int i = lo, j = mid + 1, k = 0;
  while (i <= mid && j <= hi) tmp[k++] = a[i] <= a[j] ? a[i++] : a[j++];
  while (i <= mid) tmp[k++] = a[i++];
  while (j <= hi) tmp[k++] = a[j++];
  for (int x = 0; x < n; x = x + 1) a[lo + x] = tmp[x];
  free(tmp);
}
void mergesort(int *a, int lo, int hi) {
  if (lo >= hi) return;
  int mid = (lo + hi) / 2;
  mergesort(a, lo, mid);
  mergesort(a, mid + 1, hi);
  merge(a, lo, mid, hi);
}
int main(void) {
  int a[9] = {9, 5, 1, 4, 3, 8, 2, 7, 6};
  mergesort(a, 0, 8);
  for (int i = 0; i < 9; i = i + 1) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 2 3 4 5 6 7 8 9 \n', 'C17 recursive merge sort (uses ++ in expressions)', r.stdout),
});

// ============================== C: multi-file (18-19) ==============================

add({
  name: 'C18 multi-file: gcd/lcm module',
  files: [
    {
      path: 'mathutils.h',
      content: `#ifndef MATHUTILS_H\n#define MATHUTILS_H\nint gcd(int a, int b);\nint lcm(int a, int b);\n#endif\n`,
    },
    {
      path: 'mathutils.c',
      content: `#include "mathutils.h"\nint gcd(int a, int b) { while (b) { int t = b; b = a % b; a = t; } return a; }\nint lcm(int a, int b) { return a / gcd(a, b) * b; }\n`,
    },
    {
      path: 'main.c',
      content: `#include <stdio.h>\n#include "mathutils.h"\nint main(void) { printf("gcd=%d lcm=%d\\n", gcd(48, 18), lcm(4, 6)); return 0; }\n`,
    },
  ],
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'gcd=6 lcm=12', 'C18 multi-file gcd/lcm module', r.stdout),
});

add({
  name: 'C19 multi-file: array-based stack module',
  files: [
    {
      path: 'stack.h',
      content: `#ifndef STACK_H\n#define STACK_H\n#define STACK_CAP 32\nstruct Stack { int data[STACK_CAP]; int top; };\nvoid stack_init(struct Stack *s);\nvoid stack_push(struct Stack *s, int v);\nint stack_pop(struct Stack *s);\nint stack_empty(struct Stack *s);\n#endif\n`,
    },
    {
      path: 'stack.c',
      content: `#include "stack.h"\nvoid stack_init(struct Stack *s) { s->top = 0; }\nvoid stack_push(struct Stack *s, int v) { s->data[s->top] = v; s->top = s->top + 1; }\nint stack_pop(struct Stack *s) { s->top = s->top - 1; return s->data[s->top]; }\nint stack_empty(struct Stack *s) { return s->top == 0; }\n`,
    },
    {
      path: 'main.c',
      content: `#include <stdio.h>\n#include "stack.h"\nint main(void) {\n  struct Stack s;\n  stack_init(&s);\n  for (int i = 1; i <= 5; i = i + 1) stack_push(&s, i);\n  int sum = 0;\n  while (!stack_empty(&s)) sum = sum + stack_pop(&s);\n  printf("sum=%d\\n", sum);\n  return 0;\n}\n`,
    },
  ],
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'sum=15', 'C19 multi-file stack module', r.stdout),
});

// ============================== C++: simple/medium (20-24) ==============================

add({
  name: 'C++20 Rectangle/Circle area classes',
  files: singleCpp(`#include <stdio.h>
class Rectangle {
public:
  double w, h;
  Rectangle(double width, double height) : w(width), h(height) {}
  double area() { return w * h; }
};
class Circle {
public:
  double r;
  Circle(double radius) : r(radius) {}
  double area() { return 3.14159 * r * r; }
};
int main(void) {
  Rectangle rect(4, 5);
  Circle circ(3);
  printf("rect=%.2f circle=%.2f\\n", rect.area(), circ.area());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'rect=20.00 circle=28.27', 'C++20 Rectangle/Circle area', r.stdout),
});

add({
  name: 'C++21 BankAccount with two instances',
  files: singleCpp(`#include <stdio.h>
class BankAccount {
public:
  double balance;
  BankAccount(double initial) : balance(initial) {}
  void deposit(double amt) { balance = balance + amt; }
  int withdraw(double amt) {
    if (amt > balance) return 0;
    balance = balance - amt;
    return 1;
  }
};
int main(void) {
  BankAccount a(100);
  BankAccount b(50);
  a.deposit(25);
  int ok = a.withdraw(200);
  b.deposit(10);
  printf("a=%.2f b=%.2f ok=%d\\n", a.balance, b.balance, ok);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'a=125.00 b=60.00 ok=0', 'C++21 BankAccount two instances', r.stdout),
});

add({
  name: 'C++22 class-based fixed-capacity stack',
  files: singleCpp(`#include <stdio.h>
class IntStack {
public:
  int data[16];
  int top;
  IntStack() { top = 0; }
  void push(int v) { data[top] = v; top = top + 1; }
  int pop() { top = top - 1; return data[top]; }
  int empty() { return top == 0; }
};
int main(void) {
  IntStack s;
  for (int i = 1; i <= 5; i = i + 1) s.push(i);
  while (!s.empty()) printf("%d ", s.pop());
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '5 4 3 2 1 \n', 'C++22 class-based stack (LIFO order)', r.stdout),
});

add({
  name: 'C++23 class-based linked list',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
struct Node { int val; Node *next; };
class LinkedList {
public:
  Node *head;
  LinkedList() { head = 0; }
  void push_front(int v) {
    Node *n = (Node *)malloc(sizeof(Node));
    n->val = v;
    n->next = head;
    head = n;
  }
  int sum() {
    int total = 0;
    for (Node *c = head; c; c = c->next) total = total + c->val;
    return total;
  }
};
int main(void) {
  LinkedList list;
  for (int i = 1; i <= 5; i = i + 1) list.push_front(i * 10);
  printf("sum=%d\\n", list.sum());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'sum=150', 'C++23 class wrapping a manual linked list', r.stdout),
});

add({
  name: 'C++24 nested class-typed members + implicit-this method chaining',
  files: singleCpp(`#include <stdio.h>
class Point {
public:
  int x, y;
  Point(int px, int py) : x(px), y(py) {}
};
class Line {
public:
  Point a, b;
  Line(int x1, int y1, int x2, int y2) : a(x1, y1), b(x2, y2) {}
  int lengthSquared() {
    int dx = a.x - b.x;
    int dy = a.y - b.y;
    return dx * dx + dy * dy;
  }
};
int main(void) {
  Line l(0, 0, 3, 4);
  printf("lenSq=%d ax=%d ay=%d bx=%d by=%d\\n", l.lengthSquared(), l.a.x, l.a.y, l.b.x, l.b.y);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'lenSq=25 ax=0 ay=0 bx=3 by=4', 'C++24 class-typed members + nested access', r.stdout),
});

// ============================== C++: multi-file (25-26) ==============================

add({
  name: 'C++25 multi-file: header-only class shared by two translation units',
  files: [
    {
      path: 'shape.h',
      content: `#ifndef SHAPE_H
#define SHAPE_H
class Square {
public:
  int side;
  Square(int s) : side(s) {}
  int area() { return side * side; }
};
#endif
`,
    },
    {
      path: 'helper.cpp',
      content: `#include "shape.h"\nint double_area(Square s) { return s.area() * 2; }\n`,
    },
    {
      path: 'main.cpp',
      content: `#include <stdio.h>
#include "shape.h"
int double_area(Square s);
int main(void) {
  Square sq(6);
  printf("area=%d doubled=%d\\n", sq.area(), double_area(sq));
  return 0;
}
`,
    },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'area=36 doubled=72', 'C++25 multi-file shared header class', r.stdout),
});

add({
  name: 'C++26 multi-file: class implemented in one file, used from another via plain C-linkage-style header',
  files: [
    {
      path: 'counter.h',
      content: `#ifndef COUNTER_H
#define COUNTER_H
class Counter {
public:
  int value;
  Counter() { value = 0; }
  void increment() { value = value + 1; }
};
Counter *make_preloaded_counter(int start);
#endif
`,
    },
    {
      path: 'counter.cpp',
      content: `#include <stdlib.h>
#include "counter.h"
Counter *make_preloaded_counter(int start) {
  Counter *c = (Counter *)malloc(sizeof(Counter));
  c->value = start;
  return c;
}
`,
    },
    {
      path: 'main.cpp',
      content: `#include <stdio.h>
#include "counter.h"
int main(void) {
  Counter *c = make_preloaded_counter(100);
  c->increment();
  c->increment();
  printf("value=%d\\n", c->value);
  return 0;
}
`,
    },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'value=102', 'C++26 multi-file factory function returning class pointer', r.stdout),
});

// ============================== C: stdin-driven (27) ==============================

add({
  name: 'C27 scanf-driven simple statistics',
  files: single(`#include <stdio.h>
int main(void) {
  int n;
  scanf("%d", &n);
  int sum = 0, mx = -1000000;
  for (int i = 0; i < n; i = i + 1) {
    int v;
    scanf("%d", &v);
    sum = sum + v;
    if (v > mx) mx = v;
  }
  printf("sum=%d max=%d\\n", sum, mx);
  return 0;
}`),
  entry: 'main.c',
  stdin: '5\n3 9 1 7 4\n',
  check: (r) => check(r.stdout.trim() === 'sum=24 max=9', 'C27 scanf-driven stats', r.stdout),
});

// ============================== C: more advanced (28-29) ==============================

add({
  name: 'C28 struct-by-value return + assignment copy semantics',
  files: single(`#include <stdio.h>
struct Point { int x; int y; };
struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}
int main(void) {
  struct Point a = make_point(3, 4);
  struct Point b = make_point(10, 20);
  struct Point c;
  c = a;
  c.x = 999;
  printf("%d %d %d %d %d %d\\n", a.x, a.y, b.x, b.y, c.x, c.y);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '3 4 10 20 999 4', 'C28 struct return + copy independence', r.stdout),
});

add({
  name: 'C29 recursive N-Queens counter (backtracking)',
  files: single(`#include <stdio.h>
int cols[8], diag1[16], diag2[16];
int count_solutions(int row, int n) {
  if (row == n) return 1;
  int total = 0;
  for (int c = 0; c < n; c = c + 1) {
    if (cols[c] || diag1[row + c] || diag2[row - c + n]) continue;
    cols[c] = 1; diag1[row + c] = 1; diag2[row - c + n] = 1;
    total = total + count_solutions(row + 1, n);
    cols[c] = 0; diag1[row + c] = 0; diag2[row - c + n] = 0;
  }
  return total;
}
int main(void) {
  printf("%d\\n", count_solutions(0, 8));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '92', 'C29 8-queens backtracking (92 solutions)', r.stdout),
});

// ============================== C/C++: continue/break regression (30-31) ==============================
// Dedicated coverage for the exact bug class C29 surfaced: `continue` inside a `for` loop must
// run the step before re-checking the condition, not skip straight back to the condition.

add({
  name: 'C30 nested for loops with continue and break combined',
  files: single(`#include <stdio.h>
int main(void) {
  int total = 0;
  for (int i = 0; i < 5; i = i + 1) {
    if (i == 1) continue;
    for (int j = 0; j < 5; j = j + 1) {
      if (j == 3) break;
      if (j % 2 == 0) continue;
      total = total + i * 10 + j;
    }
  }
  printf("%d\\n", total);
  return 0;
}`),
  entry: 'main.c',
  // i in {0,2,3,4} (i==1 skipped); for each, j in {1} only (j=0,2 skipped by continue, j=3 breaks)
  // sum = (0*10+1)+(2*10+1)+(3*10+1)+(4*10+1) = 1+21+31+41 = 94
  check: (r) => check(r.stdout.trim() === '94', 'C30 nested for-loop continue/break', r.stdout),
});

add({
  name: "C++31 method with a for-loop continue (skip-even accumulator)",
  files: singleCpp(`#include <stdio.h>
class Accumulator {
public:
  int total;
  Accumulator() { total = 0; }
  void sumOddsUpTo(int n) {
    for (int i = 0; i <= n; i = i + 1) {
      if (i % 2 == 0) continue;
      total = total + i;
    }
  }
};
int main(void) {
  Accumulator a;
  a.sumOddsUpTo(10);
  printf("%d\\n", a.total);
  return 0;
}`),
  entry: 'main.cpp',
  // odds 1..9: 1+3+5+7+9 = 25
  check: (r) => check(r.stdout.trim() === '25', 'C++31 method for-loop continue', r.stdout),
});

// ============================== run ==============================

async function run() {
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

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
