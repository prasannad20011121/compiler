/**
 * Second C++ battery: 30 NEW programs (distinct from tests/cpp-smoke.ts and
 * tests/battery-smoke.ts's C++ cases), pushing further within the supported
 * subset: more class interactions, self-referential class-typed nodes,
 * heap churn, multi-file class composition, and mixed this/bare-field access.
 */
import { check, runBattery, singleCpp, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'C++1 Calculator class',
  files: singleCpp(`#include <stdio.h>
class Calculator {
public:
  int add(int a, int b) { return a + b; }
  int sub(int a, int b) { return a - b; }
  int mul(int a, int b) { return a * b; }
  int divide(int a, int b) { return a / b; }
};
int main(void) {
  Calculator c;
  printf("%d %d %d %d\\n", c.add(6, 3), c.sub(6, 3), c.mul(6, 3), c.divide(6, 3));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '9 3 18 2', 'C++1 Calculator class', r.stdout),
});

add({
  name: 'C++2 Matrix class (2x2 multiply)',
  files: singleCpp(`#include <stdio.h>
class Matrix2 {
public:
  int m[2][2];
  void set(int a, int b, int c, int d) { m[0][0] = a; m[0][1] = b; m[1][0] = c; m[1][1] = d; }
  Matrix2 multiply(Matrix2 other) {
    Matrix2 r;
    for (int i = 0; i < 2; i = i + 1) {
      for (int j = 0; j < 2; j = j + 1) {
        int sum = 0;
        for (int k = 0; k < 2; k = k + 1) sum = sum + m[i][k] * other.m[k][j];
        r.m[i][j] = sum;
      }
    }
    return r;
  }
};
int main(void) {
  Matrix2 a; a.set(1, 2, 3, 4);
  Matrix2 b; b.set(5, 6, 7, 8);
  Matrix2 c = a.multiply(b);
  printf("%d %d %d %d\\n", c.m[0][0], c.m[0][1], c.m[1][0], c.m[1][1]);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '19 22 43 50', 'C++2 Matrix class multiply', r.stdout),
});

add({
  name: 'C++3 array-based Queue class (FIFO)',
  files: singleCpp(`#include <stdio.h>
class Queue {
public:
  int data[16];
  int front, rear;
  Queue() { front = 0; rear = 0; }
  void enqueue(int v) { data[rear] = v; rear = rear + 1; }
  int dequeue() { int v = data[front]; front = front + 1; return v; }
  int empty() { return front == rear; }
};
int main(void) {
  Queue q;
  for (int i = 1; i <= 5; i = i + 1) q.enqueue(i);
  while (!q.empty()) printf("%d ", q.dequeue());
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '1 2 3 4 5 \n', 'C++3 array-based Queue (FIFO order)', r.stdout),
});

add({
  name: 'C++4 DoubleStack class',
  files: singleCpp(`#include <stdio.h>
class DoubleStack {
public:
  double data[16];
  int top;
  DoubleStack() { top = 0; }
  void push(double v) { data[top] = v; top = top + 1; }
  double pop() { top = top - 1; return data[top]; }
};
int main(void) {
  DoubleStack s;
  s.push(1.5); s.push(2.5); s.push(3.5);
  double sum = 0;
  double a = s.pop(); double b = s.pop(); double c = s.pop();
  sum = a + b + c;
  printf("%.1f %.1f %.1f sum=%.1f\\n", a, b, c, sum);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '3.5 2.5 1.5 sum=7.5', 'C++4 DoubleStack class', r.stdout),
});

add({
  name: 'C++5 Range class validated by a free function',
  files: singleCpp(`#include <stdio.h>
class Range {
public:
  int lo, hi;
  Range(int a, int b) : lo(a), hi(b) {}
};
int contains(Range *r, int v) { return v >= r->lo && v <= r->hi; }
int main(void) {
  Range r(0, 10);
  printf("%d %d\\n", contains(&r, 5), contains(&r, 15));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '1 0', 'C++5 Range validated by free function', r.stdout),
});

add({
  name: 'C++6 factory free function returning a heap class object',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
class Circle {
public:
  double r;
  Circle(double radius) : r(radius) {}
  double area() { return 3.14159 * r * r; }
};
Circle *create_circle(double radius) {
  Circle *c = (Circle *)malloc(sizeof(Circle));
  c->r = radius;
  return c;
}
int main(void) {
  Circle *c = create_circle(2);
  printf("%.2f\\n", c->area());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '12.57', 'C++6 factory function returning heap object', r.stdout),
});

add({
  name: 'C++7 recursive method (MathHelper::factorial)',
  files: singleCpp(`#include <stdio.h>
class MathHelper {
public:
  long factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
  }
};
int main(void) {
  MathHelper h;
  printf("%ld\\n", h.factorial(6));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '720', 'C++7 recursive method call', r.stdout),
});

add({
  name: 'C++8 class-wrapped stack of self-referential Node pointers (LIFO)',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
struct Node { int val; Node *next; };
class NodeStack {
public:
  Node *top;
  NodeStack() { top = 0; }
  void push(int v) {
    Node *n = (Node *)malloc(sizeof(Node));
    n->val = v; n->next = top; top = n;
  }
  int pop() {
    int v = top->val;
    top = top->next;
    return v;
  }
};
int main(void) {
  NodeStack s;
  for (int i = 1; i <= 5; i = i + 1) s.push(i);
  for (int i = 0; i < 5; i = i + 1) printf("%d ", s.pop());
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '5 4 3 2 1 \n', 'C++8 node-pointer stack (LIFO)', r.stdout),
});

add({
  name: 'C++9 class-based BST insert + inorder traversal',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
struct TreeNode { int val; TreeNode *left; TreeNode *right; };
class BST {
public:
  TreeNode *root;
  BST() { root = 0; }
  void insert(int v) { root = insertHelper(root, v); }
  TreeNode *insertHelper(TreeNode *node, int v) {
    if (!node) {
      TreeNode *n = (TreeNode *)malloc(sizeof(TreeNode));
      n->val = v; n->left = 0; n->right = 0;
      return n;
    }
    if (v < node->val) node->left = insertHelper(node->left, v);
    else node->right = insertHelper(node->right, v);
    return node;
  }
  void inorder(TreeNode *node) {
    if (!node) return;
    inorder(node->left);
    printf("%d ", node->val);
    inorder(node->right);
  }
  void printAll() { inorder(root); printf("\\n"); }
};
int main(void) {
  BST tree;
  int vals[7] = {5, 3, 8, 1, 4, 7, 9};
  for (int i = 0; i < 7; i = i + 1) tree.insert(vals[i]);
  tree.printAll();
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '1 3 4 5 7 8 9 \n', 'C++9 class-based BST inorder', r.stdout),
});

add({
  name: 'C++10 letter-frequency counter class',
  files: singleCpp(`#include <stdio.h>
class FreqCounter {
public:
  int freq[26];
  FreqCounter() { for (int i = 0; i < 26; i = i + 1) freq[i] = 0; }
  void countAll(const char *s) { for (int i = 0; s[i]; i = i + 1) freq[s[i] - 'a'] = freq[s[i] - 'a'] + 1; }
  int countOf(char c) { return freq[c - 'a']; }
};
int main(void) {
  FreqCounter fc;
  fc.countAll("mississippi");
  printf("i=%d s=%d p=%d m=%d\\n", fc.countOf('i'), fc.countOf('s'), fc.countOf('p'), fc.countOf('m'));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'i=4 s=4 p=2 m=1', 'C++10 letter frequency counter class', r.stdout),
});

add({
  name: 'C++11 multi-file: Square class shared header, areas summed across files',
  files: [
    { path: 'square.h', content: `#ifndef SQUARE_H\n#define SQUARE_H\nclass Square {\npublic:\n  int side;\n  Square(int s) : side(s) {}\n  int area() { return side * side; }\n};\n#endif\n` },
    { path: 'helper.cpp', content: `#include "square.h"\nint area_of(Square s) { return s.area(); }\n` },
    { path: 'main.cpp', content: `#include <stdio.h>\n#include "square.h"\nint area_of(Square s);\nint main(void) {\n  Square a(3);\n  Square b(4);\n  printf("%d\\n", area_of(a) + area_of(b));\n  return 0;\n}\n` },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '25', 'C++11 multi-file Square area sum', r.stdout),
});

add({
  name: 'C++12 multi-file: Vector2D math class (add, dot, length)',
  files: [
    {
      path: 'vec2.h',
      content: `#ifndef VEC2_H
#define VEC2_H
class Vector2D {
public:
  double x, y;
  Vector2D(double px, double py) : x(px), y(py) {}
  Vector2D add(Vector2D other) { return Vector2D(x + other.x, y + other.y); }
  double dot(Vector2D other) { return x * other.x + y * other.y; }
  double length() {
    double v = x * x + y * y;
    double guess = v > 1.0 ? v / 2.0 : 1.0;
    for (int i = 0; i < 30; i = i + 1) guess = 0.5 * (guess + v / guess);
    return guess;
  }
};
#endif
`,
    },
    { path: 'ops.cpp', content: `#include "vec2.h"\ndouble dot_product(Vector2D a, Vector2D b) { return a.dot(b); }\n` },
    {
      path: 'main.cpp',
      content: `#include <stdio.h>
#include "vec2.h"
double dot_product(Vector2D a, Vector2D b);
int main(void) {
  Vector2D a(3, 4);
  Vector2D b(1, 1);
  Vector2D s = a.add(b);
  printf("%.1f %.1f %.2f %.1f\\n", s.x, s.y, dot_product(a, b), a.length());
  return 0;
}
`,
    },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '4.0 5.0 7.00 5.0', 'C++12 multi-file Vector2D math', r.stdout),
});

add({
  name: 'C++13 mixing this->field and bare field in one method',
  files: singleCpp(`#include <stdio.h>
class Foo {
public:
  int x;
  void set(int v) { this->x = v; }
  int getViaThis() { return this->x; }
  int getBare() { return x; }
};
int main(void) {
  Foo f;
  f.set(42);
  printf("%d %d\\n", f.getViaThis(), f.getBare());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '42 42', "C++13 this-> and bare field both work", r.stdout),
});

add({
  name: 'C++14 chained implicit-this method calls (m1 -> m2 -> m3)',
  files: singleCpp(`#include <stdio.h>
class Chain {
public:
  int m3() { return 10; }
  int m2() { return m3() + 1; }
  int m1() { return m2() + 1; }
};
int main(void) {
  Chain c;
  printf("%d\\n", c.m1());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '12', 'C++14 chained method calls', r.stdout),
});

add({
  name: 'C++15 new/delete churn (100 objects)',
  files: singleCpp(`#include <stdio.h>
class Counter {
public:
  int id;
  Counter(int i) : id(i) {}
};
int main(void) {
  int sum = 0;
  for (int i = 0; i < 100; i = i + 1) {
    Counter *c = new Counter(i);
    sum = sum + c->id;
    delete c;
  }
  printf("%d\\n", sum);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '4950', 'C++15 new/delete churn sum 0..99', r.stdout),
});

add({
  name: 'C++16 StringBuilder-like class over a malloc buffer',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
class StringBuilder {
public:
  char *buf;
  int len;
  StringBuilder() { buf = (char *)malloc(64); len = 0; }
  void append(char c) { buf[len] = c; len = len + 1; buf[len] = 0; }
};
int main(void) {
  StringBuilder sb;
  sb.append('H'); sb.append('i'); sb.append('!');
  printf("%s len=%d\\n", sb.buf, sb.len);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'Hi! len=3', 'C++16 StringBuilder over malloc buffer', r.stdout),
});

add({
  name: 'C++17 free function taking a class object by value (Manhattan distance)',
  files: singleCpp(`#include <stdio.h>
class Point {
public:
  int x, y;
  Point(int px, int py) : x(px), y(py) {}
};
int manhattan(Point a, Point b) {
  int dx = a.x - b.x; if (dx < 0) dx = -dx;
  int dy = a.y - b.y; if (dy < 0) dy = -dy;
  return dx + dy;
}
int main(void) {
  Point a(0, 0);
  Point b(3, 4);
  printf("%d\\n", manhattan(a, b));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '7', 'C++17 free function taking class by value', r.stdout),
});

add({
  name: 'C++18 constructor clamps invalid input',
  files: singleCpp(`#include <stdio.h>
class Rectangle {
public:
  int w, h;
  Rectangle(int width, int height) {
    w = width < 0 ? 0 : width;
    h = height < 0 ? 0 : height;
  }
  int area() { return w * h; }
};
int main(void) {
  Rectangle r(-5, 10);
  printf("%d %d %d\\n", r.w, r.h, r.area());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '0 10 0', 'C++18 constructor clamping', r.stdout),
});

add({
  name: 'C++19 Fraction class reduced via a free gcd function',
  files: singleCpp(`#include <stdio.h>
int gcd(int a, int b) { while (b) { int t = b; b = a % b; a = t; } return a; }
class Fraction {
public:
  int num, den;
  Fraction(int n, int d) {
    int g = gcd(n, d);
    num = n / g;
    den = d / g;
  }
};
int main(void) {
  Fraction f(6, 8);
  printf("%d/%d\\n", f.num, f.den);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '3/4', 'C++19 Fraction reduced via gcd', r.stdout),
});

add({
  name: 'C++20 Histogram class with fixed buckets',
  files: singleCpp(`#include <stdio.h>
class Histogram {
public:
  int buckets[5];
  Histogram() { for (int i = 0; i < 5; i = i + 1) buckets[i] = 0; }
  void add(int v) { buckets[v] = buckets[v] + 1; }
};
int main(void) {
  Histogram h;
  int vals[7] = {0, 1, 1, 2, 4, 4, 4};
  for (int i = 0; i < 7; i = i + 1) h.add(vals[i]);
  for (int i = 0; i < 5; i = i + 1) printf("%d ", h.buckets[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '1 2 1 0 3 \n', 'C++20 Histogram with fixed buckets', r.stdout),
});

add({
  name: 'C++21 TrafficLight state machine (switch inside a method)',
  files: singleCpp(`#include <stdio.h>
class TrafficLight {
public:
  int state;
  TrafficLight() { state = 0; }
  void next() {
    switch (state) {
      case 0: state = 1; break;
      case 1: state = 2; break;
      default: state = 0;
    }
  }
};
int main(void) {
  TrafficLight t;
  for (int i = 0; i < 4; i = i + 1) { t.next(); printf("%d ", t.state); }
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '1 2 0 1 \n', 'C++21 TrafficLight state machine', r.stdout),
});

add({
  name: 'C++22 multi-file Logger class with a fixed in-object buffer',
  files: [
    {
      path: 'logger.h',
      content: `#ifndef LOGGER_H
#define LOGGER_H
class Logger {
public:
  char buf[256];
  int len;
  Logger() { len = 0; buf[0] = 0; }
  void log(const char *msg) {
    int i = 0;
    while (msg[i]) { buf[len] = msg[i]; len = len + 1; i = i + 1; }
    buf[len] = ';'; len = len + 1;
    buf[len] = 0;
  }
};
#endif
`,
    },
    { path: 'moduleA.cpp', content: `#include "logger.h"\nvoid log_from_a(Logger *l) { l->log("A"); }\n` },
    {
      path: 'main.cpp',
      content: `#include <stdio.h>
#include "logger.h"
void log_from_a(Logger *l);
int main(void) {
  Logger logger;
  log_from_a(&logger);
  logger.log("main");
  printf("%s\\n", logger.buf);
  return 0;
}
`,
    },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'A;main;', 'C++22 multi-file Logger shared header', r.stdout),
});

add({
  name: 'C++23 constructor mixing nested class field and scalar fields',
  files: singleCpp(`#include <stdio.h>
class Point {
public:
  int x, y;
  Point(int px, int py) : x(px), y(py) {}
};
class Circle {
public:
  Point center;
  int radius;
  Circle(int cx, int cy, int r) : center(cx, cy), radius(r) {}
};
int main(void) {
  Circle c(1, 2, 5);
  printf("%d %d %d\\n", c.center.x, c.center.y, c.radius);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '1 2 5', 'C++23 ctor mixing nested + scalar member-inits', r.stdout),
});

add({
  name: 'C++24 Complex number class with named add/multiply methods',
  files: singleCpp(`#include <stdio.h>
class Complex {
public:
  int re, im;
  Complex(int r, int i) : re(r), im(i) {}
  Complex add(Complex o) { return Complex(re + o.re, im + o.im); }
  Complex multiply(Complex o) { return Complex(re * o.re - im * o.im, re * o.im + im * o.re); }
};
int main(void) {
  Complex a(3, 4);
  Complex b(1, 2);
  Complex s = a.add(b);
  Complex p = a.multiply(b);
  printf("%d+%di %d+%di\\n", s.re, s.im, p.re, p.im);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '4+6i -5+10i', 'C++24 Complex number add/multiply', r.stdout),
});

add({
  name: 'C++25 memoized Fibonacci class (array-backed cache)',
  files: singleCpp(`#include <stdio.h>
class FibCalculator {
public:
  long cache[20];
  int computed[20];
  FibCalculator() { for (int i = 0; i < 20; i = i + 1) computed[i] = 0; }
  long fib(int n) {
    if (n <= 1) return n;
    if (computed[n]) return cache[n];
    long result = fib(n - 1) + fib(n - 2);
    cache[n] = result;
    computed[n] = 1;
    return result;
  }
};
int main(void) {
  FibCalculator f;
  printf("%ld\\n", f.fib(15));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '610', 'C++25 memoized Fibonacci class', r.stdout),
});

add({
  name: 'C++26 Queue via malloc-linked class-wrapped nodes',
  files: singleCpp(`#include <stdio.h>
#include <stdlib.h>
struct QNode { int val; QNode *next; };
class LinkedQueue {
public:
  QNode *front;
  QNode *back;
  LinkedQueue() { front = 0; back = 0; }
  void enqueue(int v) {
    QNode *n = (QNode *)malloc(sizeof(QNode));
    n->val = v; n->next = 0;
    if (!front) { front = n; back = n; } else { back->next = n; back = n; }
  }
  int dequeue() {
    int v = front->val;
    front = front->next;
    return v;
  }
};
int main(void) {
  LinkedQueue q;
  q.enqueue(10); q.enqueue(20); q.enqueue(30);
  int a = q.dequeue(), b = q.dequeue(), c = q.dequeue();
  printf("%d %d %d sum=%d\\n", a, b, c, a + b + c);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '10 20 30 sum=60', 'C++26 linked Queue class', r.stdout),
});

add({
  name: "C++27 utility class methods that don't touch `this`",
  files: singleCpp(`#include <stdio.h>
class MathUtils {
public:
  int square(int x) { return x * x; }
  int cube(int x) { return x * x * x; }
};
int main(void) {
  MathUtils u;
  printf("%d %d\\n", u.square(7), u.cube(3));
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '49 27', "C++27 methods not touching this", r.stdout),
});

add({
  name: 'C++28 Sorter class wrapping bubble sort over an array member',
  files: singleCpp(`#include <stdio.h>
class Sorter {
public:
  int data[5];
  void setAt(int i, int v) { data[i] = v; }
  void sort() {
    for (int i = 0; i < 4; i = i + 1) {
      for (int j = 0; j < 4 - i; j = j + 1) {
        if (data[j] > data[j + 1]) { int t = data[j]; data[j] = data[j + 1]; data[j + 1] = t; }
      }
    }
  }
};
int main(void) {
  Sorter s;
  int vals[5] = {5, 3, 8, 1, 9};
  for (int i = 0; i < 5; i = i + 1) s.setAt(i, vals[i]);
  s.sort();
  for (int i = 0; i < 5; i = i + 1) printf("%d ", s.data[i]);
  printf("\\n");
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '1 3 5 8 9 \n', 'C++28 Sorter class wrapping bubble sort', r.stdout),
});

add({
  name: 'C++29 multi-file: Car composed with a pointer to an Engine from a separate header',
  files: [
    { path: 'engine.h', content: `#ifndef ENGINE_H\n#define ENGINE_H\nclass Engine {\npublic:\n  int power;\n  Engine(int p) : power(p) {}\n  int horsepower() { return power; }\n};\n#endif\n` },
    {
      path: 'car.h',
      content: `#ifndef CAR_H
#define CAR_H
#include "engine.h"
class Car {
public:
  Engine *engine;
  Car() { engine = 0; }
  void attachEngine(Engine *e) { engine = e; }
  int totalPower() { return engine->horsepower(); }
};
#endif
`,
    },
    { path: 'main.cpp', content: `#include <stdio.h>\n#include "car.h"\nint main(void) {\n  Engine e(300);\n  Car c;\n  c.attachEngine(&e);\n  printf("%d\\n", c.totalPower());\n  return 0;\n}\n` },
  ],
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '300', 'C++29 multi-file Car composed with Engine pointer', r.stdout),
});

add({
  name: 'C++30 Statistics class computing min/max/sum over an array member',
  files: singleCpp(`#include <stdio.h>
class Statistics {
public:
  int values[6];
  Statistics() {
    int data[6] = {4, 8, 15, 16, 23, 42};
    for (int i = 0; i < 6; i = i + 1) values[i] = data[i];
  }
  int sum() {
    int s = 0;
    for (int i = 0; i < 6; i = i + 1) s = s + values[i];
    return s;
  }
  int minVal() {
    int m = values[0];
    for (int i = 1; i < 6; i = i + 1) if (values[i] < m) m = values[i];
    return m;
  }
  int maxVal() {
    int m = values[0];
    for (int i = 1; i < 6; i = i + 1) if (values[i] > m) m = values[i];
    return m;
  }
};
int main(void) {
  Statistics stats;
  printf("min=%d max=%d sum=%d\\n", stats.minVal(), stats.maxVal(), stats.sum());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === 'min=4 max=42 sum=108', 'C++30 Statistics class min/max/sum', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
