import { check, runBattery, single, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'di1 designated struct initializer, fields out of order',
  files: single(`#include <stdio.h>
struct Point { int x; int y; int z; };
int main(void) {
  struct Point p = {.z = 3, .x = 1, .y = 2};
  printf("%d %d %d\\n", p.x, p.y, p.z);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1 2 3', 'di1 designated struct fields', r.stdout),
});

add({
  name: 'di2 array designator with inferred length',
  files: single(`#include <stdio.h>
int main(void) {
  int arr[] = {[3] = 40, [0] = 10};
  int n = sizeof(arr) / sizeof(arr[0]);
  printf("%d %d %d %d %d\\n", n, arr[0], arr[1], arr[2], arr[3]);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '4 10 0 0 40', 'di2 array designator length inference', r.stdout),
});

add({
  name: 'di3 global designated initializer (compile-time constant)',
  files: single(`#include <stdio.h>
struct Color { int r; int g; int b; };
struct Color c = {.g = 200, .b = 50};
int main(void) {
  printf("%d %d %d\\n", c.r, c.g, c.b);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '0 200 50', 'di3 global designated struct initializer', r.stdout),
});

add({
  name: 'cl1 compound literal used directly as a call argument',
  files: single(`#include <stdio.h>
struct Point { int x; int y; };
int sum_point(struct Point p) { return p.x + p.y; }
int main(void) {
  printf("%d\\n", sum_point((struct Point){3, 4}));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '7', 'cl1 compound literal as call arg', r.stdout),
});

add({
  name: 'cl2 compound literal assigned to a variable, then mutated (a fresh object each time)',
  files: single(`#include <stdio.h>
struct Point { int x; int y; };
int main(void) {
  struct Point a = (struct Point){1, 2};
  struct Point b = (struct Point){.x = 5, .y = 6};
  a.x = 100;
  printf("%d %d %d %d\\n", a.x, a.y, b.x, b.y);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '100 2 5 6', 'cl2 compound literal assigned + mutated independently', r.stdout),
});

add({
  name: 'cl3 array compound literal indexed directly',
  files: single(`#include <stdio.h>
int main(void) {
  printf("%d\\n", (int[]){10, 20, 30}[1]);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '20', 'cl3 array compound literal indexing', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
