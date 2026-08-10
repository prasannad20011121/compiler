/**
 * Second C battery: 30 NEW programs (distinct from tests/battery-smoke.ts),
 * covering ground the first battery didn't: bitwise ops, unions, enums,
 * function pointers, custom variadics, 2D dynamic arrays, static locals,
 * double pointers, more multi-file programs, and classic recursion puzzles.
 */
import { check, runBattery, single, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'C1 bitwise operators + popcount',
  files: single(`#include <stdio.h>
int popcount(unsigned int x) {
  int n = 0;
  while (x) { n = n + (x & 1); x = x >> 1; }
  return n;
}
int main(void) {
  int a = 12, b = 10;
  printf("%d %d %d %d %d %d %d\\n", a & b, a | b, a ^ b, ~a, a << 2, a >> 2, popcount((unsigned int)a));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '8 14 6 -13 48 3 2', 'C1 bitwise ops + popcount', r.stdout),
});

add({
  name: 'C2 palindrome checker',
  files: single(`#include <stdio.h>
#include <string.h>
int is_palindrome(const char *s) {
  int i = 0, j = (int)strlen(s) - 1;
  while (i < j) { if (s[i] != s[j]) return 0; i = i + 1; j = j - 1; }
  return 1;
}
int main(void) {
  printf("%d %d\\n", is_palindrome("racecar"), is_palindrome("hello"));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1 0', 'C2 palindrome checker', r.stdout),
});

add({
  name: 'C3 anagram checker via frequency count',
  files: single(`#include <stdio.h>
#include <string.h>
int is_anagram(const char *a, const char *b) {
  if (strlen(a) != strlen(b)) return 0;
  int freq[26];
  for (int i = 0; i < 26; i = i + 1) freq[i] = 0;
  for (int i = 0; a[i]; i = i + 1) freq[a[i] - 'a'] = freq[a[i] - 'a'] + 1;
  for (int i = 0; b[i]; i = i + 1) freq[b[i] - 'a'] = freq[b[i] - 'a'] - 1;
  for (int i = 0; i < 26; i = i + 1) if (freq[i] != 0) return 0;
  return 1;
}
int main(void) {
  printf("%d %d\\n", is_anagram("listen", "silent"), is_anagram("hello", "world"));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1 0', 'C3 anagram checker', r.stdout),
});

add({
  name: 'C4 iterative binary search',
  files: single(`#include <stdio.h>
int binary_search(int *a, int n, int target) {
  int lo = 0, hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (a[mid] == target) return mid;
    if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
int main(void) {
  int a[10] = {1, 3, 5, 7, 9, 11, 13, 15, 17, 19};
  printf("%d %d\\n", binary_search(a, 10, 13), binary_search(a, 10, 4));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '6 -1', 'C4 binary search', r.stdout),
});

add({
  name: 'C5 recursive fast exponentiation',
  files: single(`#include <stdio.h>
long power(int base, int exp) {
  if (exp == 0) return 1;
  long half = power(base, exp / 2);
  long result = half * half;
  if (exp % 2 == 1) result = result * base;
  return result;
}
int main(void) {
  printf("%ld %ld\\n", power(2, 10), power(3, 5));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1024 243', 'C5 fast exponentiation', r.stdout),
});

add({
  name: 'C6 reverse a linked list in place',
  files: single(`#include <stdio.h>
#include <stdlib.h>
struct Node { int val; struct Node *next; };
struct Node *reverse(struct Node *head) {
  struct Node *prev = 0, *cur = head;
  while (cur) {
    struct Node *next = cur->next;
    cur->next = prev;
    prev = cur;
    cur = next;
  }
  return prev;
}
int main(void) {
  struct Node *head = 0;
  for (int i = 5; i >= 1; i = i - 1) {
    struct Node *n = (struct Node *)malloc(sizeof(struct Node));
    n->val = i; n->next = head; head = n;
  }
  head = reverse(head);
  for (struct Node *c = head; c; c = c->next) printf("%d ", c->val);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '5 4 3 2 1 \n', 'C6 reverse linked list in place', r.stdout),
});

add({
  name: 'C7 tagged union variant',
  files: single(`#include <stdio.h>
union Value { int i; double f; };
struct Variant { int tag; union Value v; };
void print_variant(struct Variant *var) {
  if (var->tag == 0) printf("int:%d\\n", var->v.i);
  else printf("float:%.2f\\n", var->v.f);
}
int main(void) {
  struct Variant a; a.tag = 0; a.v.i = 42;
  struct Variant b; b.tag = 1; b.v.f = 3.5;
  print_variant(&a);
  print_variant(&b);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === 'int:42\nfloat:3.50\n', 'C7 tagged union variant', r.stdout),
});

add({
  name: 'C8 enum + switch',
  files: single(`#include <stdio.h>
enum Weekday { MON, TUE, WED, THU, FRI, SAT, SUN };
const char *kind(enum Weekday d) {
  switch (d) {
    case SAT:
    case SUN:
      return "Weekend";
    default:
      return "Weekday";
  }
}
int main(void) {
  printf("%s %s\\n", kind(WED), kind(SAT));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'Weekday Weekend', 'C8 enum + switch', r.stdout),
});

add({
  name: 'C9 function pointers / operation table',
  files: single(`#include <stdio.h>
int add(int a, int b) { return a + b; }
int sub(int a, int b) { return a - b; }
int mul(int a, int b) { return a * b; }
int main(void) {
  int (*ops[3])(int, int) = { add, sub, mul };
  for (int i = 0; i < 3; i = i + 1) printf("%d ", ops[i](6, 3));
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '9 3 18 \n', 'C9 function pointer table', r.stdout),
});

add({
  name: 'C10 custom variadic sum function',
  files: single(`#include <stdio.h>
#include <stdarg.h>
int sum_ints(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int total = 0;
  for (int i = 0; i < count; i = i + 1) total = total + va_arg(ap, int);
  va_end(ap);
  return total;
}
int main(void) {
  printf("%d %d\\n", sum_ints(3, 10, 20, 30), sum_ints(5, 1, 2, 3, 4, 5));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '60 15', 'C10 custom variadic function', r.stdout),
});

add({
  name: 'C11 2D dynamic array (array of malloc rows)',
  files: single(`#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n = 3;
  int **grid = (int **)malloc(sizeof(int *) * n);
  for (int i = 0; i < n; i = i + 1) grid[i] = (int *)malloc(sizeof(int) * n);
  int sum = 0;
  for (int i = 0; i < n; i = i + 1)
    for (int j = 0; j < n; j = j + 1) {
      grid[i][j] = i * n + j;
      sum = sum + grid[i][j];
    }
  printf("%d\\n", sum);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '36', 'C11 2D dynamic array', r.stdout),
});

add({
  name: 'C12 manual whitespace tokenizer',
  files: single(`#include <stdio.h>
int main(void) {
  char text[] = "the quick brown fox";
  int i = 0;
  while (text[i]) {
    while (text[i] == ' ') i = i + 1;
    if (!text[i]) break;
    int start = i;
    while (text[i] && text[i] != ' ') i = i + 1;
    for (int k = start; k < i; k = k + 1) putchar(text[k]);
    putchar('\\n');
  }
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === 'the\nquick\nbrown\nfox\n', 'C12 manual tokenizer', r.stdout),
});

add({
  name: 'C13 selection sort',
  files: single(`#include <stdio.h>
void selection_sort(int *a, int n) {
  for (int i = 0; i < n - 1; i = i + 1) {
    int minIdx = i;
    for (int j = i + 1; j < n; j = j + 1) if (a[j] < a[minIdx]) minIdx = j;
    int t = a[i]; a[i] = a[minIdx]; a[minIdx] = t;
  }
}
int main(void) {
  int a[8] = {5, 3, 8, 1, 9, 2, 7, 4};
  selection_sort(a, 8);
  for (int i = 0; i < 8; i = i + 1) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 2 3 4 5 7 8 9 \n', 'C13 selection sort', r.stdout),
});

add({
  name: 'C14 insertion sort',
  files: single(`#include <stdio.h>
void insertion_sort(int *a, int n) {
  for (int i = 1; i < n; i = i + 1) {
    int key = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j = j - 1; }
    a[j + 1] = key;
  }
}
int main(void) {
  int a[5] = {9, 5, 1, 4, 3};
  insertion_sort(a, 5);
  for (int i = 0; i < 5; i = i + 1) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 3 4 5 9 \n', 'C14 insertion sort', r.stdout),
});

add({
  name: 'C15 counting sort',
  files: single(`#include <stdio.h>
void counting_sort(int *a, int n, int maxVal) {
  int *count = (int *)calloc(maxVal + 1, sizeof(int));
  for (int i = 0; i < n; i = i + 1) count[a[i]] = count[a[i]] + 1;
  int idx = 0;
  for (int v = 0; v <= maxVal; v = v + 1) for (int c = 0; c < count[v]; c = c + 1) { a[idx] = v; idx = idx + 1; }
  free(count);
}
int main(void) {
  int a[7] = {4, 2, 2, 8, 3, 3, 1};
  counting_sort(a, 7, 9);
  for (int i = 0; i < 7; i = i + 1) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 2 2 3 3 4 8 \n', 'C15 counting sort', r.stdout),
});

add({
  name: 'C16 multi-file: complex number arithmetic',
  files: [
    { path: 'complex.h', content: `#ifndef COMPLEX_H\n#define COMPLEX_H\nstruct Complex { int re; int im; };\nstruct Complex c_add(struct Complex a, struct Complex b);\nstruct Complex c_mul(struct Complex a, struct Complex b);\n#endif\n` },
    { path: 'complex.c', content: `#include "complex.h"\nstruct Complex c_add(struct Complex a, struct Complex b) { struct Complex r; r.re = a.re + b.re; r.im = a.im + b.im; return r; }\nstruct Complex c_mul(struct Complex a, struct Complex b) { struct Complex r; r.re = a.re * b.re - a.im * b.im; r.im = a.re * b.im + a.im * b.re; return r; }\n` },
    { path: 'main.c', content: `#include <stdio.h>\n#include "complex.h"\nint main(void) {\n  struct Complex a; a.re = 3; a.im = 4;\n  struct Complex b; b.re = 1; b.im = 2;\n  struct Complex s = c_add(a, b);\n  struct Complex p = c_mul(a, b);\n  printf("sum=%d+%di prod=%d+%di\\n", s.re, s.im, p.re, p.im);\n  return 0;\n}\n` },
  ],
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'sum=4+6i prod=-5+10i', 'C16 multi-file complex numbers', r.stdout),
});

add({
  name: 'C17 multi-file: temperature converter',
  files: [
    { path: 'temp.h', content: `#ifndef TEMP_H\n#define TEMP_H\ndouble c_to_f(double c);\ndouble f_to_c(double f);\n#endif\n` },
    { path: 'temp.c', content: `#include "temp.h"\ndouble c_to_f(double c) { return c * 9.0 / 5.0 + 32.0; }\ndouble f_to_c(double f) { return (f - 32.0) * 5.0 / 9.0; }\n` },
    { path: 'main.c', content: `#include <stdio.h>\n#include "temp.h"\nint main(void) {\n  printf("%.1f %.1f\\n", c_to_f(100.0), f_to_c(32.0));\n  return 0;\n}\n` },
  ],
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '212.0 0.0', 'C17 multi-file temperature converter', r.stdout),
});

add({
  name: 'C18 Tower of Hanoi move count',
  files: single(`#include <stdio.h>
int moves = 0;
void hanoi(int n, char from, char to, char via) {
  if (n == 0) return;
  hanoi(n - 1, from, via, to);
  moves = moves + 1;
  hanoi(n - 1, via, to, from);
}
int main(void) {
  hanoi(10, 'A', 'C', 'B');
  printf("%d\\n", moves);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1023', 'C18 Tower of Hanoi (2^10 - 1 moves)', r.stdout),
});

add({
  name: 'C19 digit sum and digit reversal',
  files: single(`#include <stdio.h>
int digit_sum(int n) {
  int s = 0;
  while (n) { s = s + n % 10; n = n / 10; }
  return s;
}
int reverse_digits(int n) {
  int r = 0;
  while (n) { r = r * 10 + n % 10; n = n / 10; }
  return r;
}
int main(void) {
  printf("%d %d\\n", digit_sum(12345), reverse_digits(12345));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '15 54321', 'C19 digit sum + reversal', r.stdout),
});

add({
  name: 'C20 leap year checker',
  files: single(`#include <stdio.h>
int is_leap(int y) { return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0); }
int main(void) {
  printf("%d %d %d %d\\n", is_leap(2000), is_leap(1900), is_leap(2024), is_leap(2023));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1 0 1 0', 'C20 leap year checker', r.stdout),
});

add({
  name: 'C21 decimal to binary string',
  files: single(`#include <stdio.h>
void to_binary(unsigned int n, char *out) {
  char buf[33];
  int len = 0;
  if (n == 0) buf[len++] = '0';
  while (n > 0) { buf[len++] = (char)('0' + (n % 2)); n = n / 2; }
  for (int i = 0; i < len; i = i + 1) out[i] = buf[len - 1 - i];
  out[len] = 0;
}
int main(void) {
  char buf[33];
  to_binary(42, buf);
  printf("%s\\n", buf);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '101010', 'C21 decimal to binary string', r.stdout),
});

add({
  name: 'C22 run-length encoding',
  files: single(`#include <stdio.h>
void rle(const char *s, char *out) {
  int i = 0, o = 0;
  while (s[i]) {
    char c = s[i];
    int count = 0;
    while (s[i] == c) { count = count + 1; i = i + 1; }
    out[o++] = c;
    char numbuf[8];
    int n = 0, cc = count;
    if (cc == 0) numbuf[n++] = '0';
    while (cc > 0) { numbuf[n++] = (char)('0' + cc % 10); cc = cc / 10; }
    for (int k = n - 1; k >= 0; k = k - 1) out[o++] = numbuf[k];
  }
  out[o] = 0;
}
int main(void) {
  char out[64];
  rle("aaabbbccd", out);
  printf("%s\\n", out);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'a3b3c2d1', 'C22 run-length encoding', r.stdout),
});

add({
  name: 'C23 struct array: student averages',
  files: single(`#include <stdio.h>
struct Student { int id; int score; };
int main(void) {
  struct Student students[3];
  students[0].id = 1; students[0].score = 85;
  students[1].id = 2; students[1].score = 92;
  students[2].id = 3; students[2].score = 78;
  int sum = 0, maxScore = -1, maxId = -1;
  for (int i = 0; i < 3; i = i + 1) {
    sum = sum + students[i].score;
    if (students[i].score > maxScore) { maxScore = students[i].score; maxId = students[i].id; }
  }
  printf("avg=%.2f top_id=%d top_score=%d\\n", (double)sum / 3.0, maxId, maxScore);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === 'avg=85.00 top_id=2 top_score=92', 'C23 struct array student averages', r.stdout),
});

add({
  name: 'C24 nested structs',
  files: single(`#include <stdio.h>
struct Address { int houseNum; int zipCode; };
struct Employee { int id; struct Address addr; };
int main(void) {
  struct Employee e;
  e.id = 7;
  e.addr.houseNum = 42;
  e.addr.zipCode = 94107;
  printf("%d %d %d\\n", e.id, e.addr.houseNum, e.addr.zipCode);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '7 42 94107', 'C24 nested structs', r.stdout),
});

add({
  name: 'C25 double pointer swap',
  files: single(`#include <stdio.h>
void swap_ptrs(int **a, int **b) {
  int *t = *a; *a = *b; *b = t;
}
int main(void) {
  int x = 5, y = 10;
  int *pa = &x, *pb = &y;
  swap_ptrs(&pa, &pb);
  printf("%d %d\\n", *pa, *pb);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '10 5', 'C25 double pointer swap', r.stdout),
});

add({
  name: 'C26 multi-file: inventory system (3 files)',
  files: [
    { path: 'inventory.h', content: `#ifndef INVENTORY_H\n#define INVENTORY_H\n#define MAX_ITEMS 16\nstruct Item { int id; int qty; };\nvoid inv_init(void);\nvoid inv_add(int id, int qty);\nint inv_find(int id);\n#endif\n` },
    { path: 'inventory.c', content: `#include "inventory.h"\nstatic struct Item items[MAX_ITEMS];\nstatic int count = 0;\nvoid inv_init(void) { count = 0; }\nvoid inv_add(int id, int qty) { items[count].id = id; items[count].qty = qty; count = count + 1; }\nint inv_find(int id) {\n  for (int i = 0; i < count; i = i + 1) if (items[i].id == id) return items[i].qty;\n  return -1;\n}\n` },
    { path: 'main.c', content: `#include <stdio.h>\n#include "inventory.h"\nint main(void) {\n  inv_init();\n  inv_add(100, 5);\n  inv_add(200, 12);\n  printf("%d %d %d\\n", inv_find(100), inv_find(200), inv_find(999));\n  return 0;\n}\n` },
  ],
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '5 12 -1', 'C26 multi-file inventory system', r.stdout),
});

add({
  name: 'C27 Ackermann function A(2,3)',
  files: single(`#include <stdio.h>
int ackermann(int m, int n) {
  if (m == 0) return n + 1;
  if (n == 0) return ackermann(m - 1, 1);
  return ackermann(m - 1, ackermann(m, n - 1));
}
int main(void) {
  printf("%d\\n", ackermann(2, 3));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '9', 'C27 Ackermann A(2,3)', r.stdout),
});

add({
  name: 'C28 static local variable persists across calls',
  files: single(`#include <stdio.h>
int next_id(void) {
  static int counter = 0;
  counter = counter + 1;
  return counter;
}
int main(void) {
  for (int i = 0; i < 5; i = i + 1) printf("%d ", next_id());
  printf("\\n");
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout === '1 2 3 4 5 \n', 'C28 static local persists across calls', r.stdout),
});

add({
  name: 'C29 const pointer parameter + pointer-arithmetic sum',
  files: single(`#include <stdio.h>
int sum_via_ptr(const int *a, int n) {
  int total = 0;
  for (const int *p = a; p < a + n; p = p + 1) total = total + *p;
  return total;
}
int main(void) {
  int a[5] = {2, 4, 6, 8, 10};
  printf("%d\\n", sum_via_ptr(a, 5));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '30', 'C29 const pointer + pointer arithmetic', r.stdout),
});

add({
  name: 'C30 longest common prefix',
  files: single(`#include <stdio.h>
#include <string.h>
void longest_common_prefix(char **strs, int n, char *out) {
  if (n == 0) { out[0] = 0; return; }
  int len = (int)strlen(strs[0]);
  for (int i = 1; i < n; i = i + 1) {
    int j = 0;
    while (j < len && j < (int)strlen(strs[i]) && strs[0][j] == strs[i][j]) j = j + 1;
    if (j < len) len = j;
  }
  for (int k = 0; k < len; k = k + 1) out[k] = strs[0][k];
  out[len] = 0;
}
int main(void) {
  char *set1[3] = {"flower", "flow", "flight"};
  char *set2[3] = {"dog", "racecar", "car"};
  char out1[32], out2[32];
  longest_common_prefix(set1, 3, out1);
  longest_common_prefix(set2, 3, out2);
  printf("[%s] [%s]\\n", out1, out2);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '[fl] []', 'C30 longest common prefix', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
