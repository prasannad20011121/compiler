import { check, runBattery, singleCpp, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'op1 operator+ / operator- returning a class by value (chained)',
  files: singleCpp(`#include <stdio.h>
class Vector2D {
public:
  int x;
  int y;
  Vector2D(int a, int b) { x = a; y = b; }
  Vector2D operator+(Vector2D o) { return Vector2D(x + o.x, y + o.y); }
  Vector2D operator-(Vector2D o) { return Vector2D(x - o.x, y - o.y); }
};
int main(void) {
  Vector2D a(1, 2);
  Vector2D b(3, 4);
  Vector2D c(10, 10);
  Vector2D r = a + b - c;
  printf("%d %d\\n", r.x, r.y);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '-6 -4', 'op1 operator+/- chained', r.stdout),
});

add({
  name: 'op2 operator== / operator!=',
  files: singleCpp(`#include <stdio.h>
class Point {
public:
  int x;
  int y;
  Point(int a, int b) { x = a; y = b; }
  int operator==(Point o) { return x == o.x && y == o.y; }
  int operator!=(Point o) { return !(x == o.x && y == o.y); }
};
int main(void) {
  Point p1(1, 2);
  Point p2(1, 2);
  Point p3(3, 4);
  printf("%d %d %d %d\\n", p1 == p2, p1 == p3, p1 != p2, p1 != p3);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '1 0 0 1', 'op2 operator==/!=', r.stdout),
});

add({
  name: 'op3 unary operator- (negation) and operator!',
  files: singleCpp(`#include <stdio.h>
class Num {
public:
  int v;
  Num(int a) { v = a; }
  Num operator-() { return Num(-v); }
  int operator!() { return v == 0; }
};
int main(void) {
  Num a(5);
  Num b = -a;
  Num zero(0);
  printf("%d %d %d\\n", b.v, !a, !zero);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '-5 0 1', 'op3 unary operator-/!', r.stdout),
});

add({
  name: 'op4 operator[] returning int& (mutable indexing) via a fixed-capacity vector class',
  files: singleCpp(`#include <stdio.h>
class IntVec {
public:
  int data[8];
  int &operator[](int i) { return data[i]; }
};
int main(void) {
  IntVec v;
  for (int i = 0; i < 5; i++) v[i] = i * i;
  v[2] = 999;
  int sum = 0;
  for (int i = 0; i < 5; i++) sum = sum + v[i];
  printf("%d %d\\n", v[2], sum);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '999 1025', 'op4 operator[] mutable indexing', r.stdout),
});

add({
  name: 'op5 operator overload resolved through inherited method (base defines operator+, derived inherits it unchanged)',
  files: singleCpp(`#include <stdio.h>
class Base {
public:
  int v;
  Base(int a) { v = a; }
  Base operator+(Base o) { return Base(v + o.v); }
};
class Derived : public Base {
public:
  Derived(int a) : Base(a) {}
};
int main(void) {
  Derived a(3);
  Derived b(4);
  Base r = a + b;
  printf("%d\\n", r.v);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '7', 'op5 inherited operator+', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
