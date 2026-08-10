import { check, runBattery, singleCpp, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'ref1 local reference binding + reference parameter',
  files: singleCpp(`#include <stdio.h>
void increment(int &x) { x = x + 1; }
int main(void) {
  int a = 5;
  int &r = a;
  r = r + 10;
  increment(a);
  printf("a=%d r=%d\\n", a, r);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'a=16 r=16', 'ref1 local ref + ref param', r.stdout),
});

add({
  name: 'ref2 swap via reference parameters',
  files: singleCpp(`#include <stdio.h>
void swap_ref(int &a, int &b) { int t = a; a = b; b = t; }
int main(void) {
  int x = 1, y = 2;
  swap_ref(x, y);
  printf("%d %d\\n", x, y);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '2 1', 'ref2 swap via references', r.stdout),
});

add({
  name: 'ref3 function returning a reference used as an lvalue (operator[]-style)',
  files: singleCpp(`#include <stdio.h>
int arr[3] = {10, 20, 30};
int &at(int i) { return arr[i]; }
int main(void) {
  at(1) = 999;
  printf("%d %d %d\\n", arr[0], at(1), arr[2]);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '10 999 30', 'ref3 reference-returning function as lvalue', r.stdout),
});

add({
  name: 'ref4 reference to a struct field, read and written through',
  files: singleCpp(`#include <stdio.h>
struct Point { int x; int y; };
int main(void) {
  Point p; p.x = 1; p.y = 2;
  int &rx = p.x;
  rx = rx + 100;
  printf("%d %d\\n", p.x, p.y);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '101 2', 'ref4 reference to struct field', r.stdout),
});

add({
  name: 'ref5 class method taking a reference parameter, mutating the caller\'s variable',
  files: singleCpp(`#include <stdio.h>
class Accumulator {
public:
  int total;
  Accumulator() { total = 0; }
  void addAndReport(int &out) {
    total = total + out;
    out = total;
  }
};
int main(void) {
  Accumulator acc;
  int v = 5;
  acc.addAndReport(v);
  v = 10;
  acc.addAndReport(v);
  printf("total=%d v=%d\\n", acc.total, v);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'total=15 v=15', 'ref5 method with reference parameter', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
