import { check, runBattery, singleCpp, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'inh1 non-virtual single inheritance: inherited field + inherited method',
  files: singleCpp(`#include <stdio.h>
class Animal {
public:
  int legs;
  void setLegs(int n) { legs = n; }
  int getLegs() { return legs; }
};
class Dog : public Animal {
public:
  int bark_count;
};
int main(void) {
  Dog d;
  d.setLegs(4);
  d.bark_count = 3;
  printf("%d %d\\n", d.getLegs(), d.bark_count);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '4 3', 'inh1 non-virtual inheritance', r.stdout),
});

add({
  name: 'inh2 virtual dispatch through an array of base pointers',
  files: singleCpp(`#include <stdio.h>
class Shape {
public:
  virtual int area() { return 0; }
};
class Square : public Shape {
public:
  int side;
  Square(int s) { side = s; }
  virtual int area() { return side * side; }
};
class Circle : public Shape {
public:
  int r;
  Circle(int rr) { r = rr; }
  virtual int area() { return 3 * r * r; }
};
int main(void) {
  Square sq(4);
  Circle c(3);
  Shape *shapes[2];
  shapes[0] = &sq;
  shapes[1] = &c;
  printf("%d %d\\n", shapes[0]->area(), shapes[1]->area());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '16 27', 'inh2 virtual dispatch via base pointer array', r.stdout),
});

add({
  name: 'inh3 constructor base-class initialization (: Base(args))',
  files: singleCpp(`#include <stdio.h>
class Base {
public:
  int x;
  Base(int v) { x = v; }
};
class Derived : public Base {
public:
  int y;
  Derived(int a, int b) : Base(a) { y = b; }
};
int main(void) {
  Derived d(10, 20);
  printf("%d %d\\n", d.x, d.y);
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '10 20', 'inh3 base-class member-init', r.stdout),
});

add({
  name: 'inh4 three-level hierarchy, each level overriding, dispatch through Animal*',
  files: singleCpp(`#include <stdio.h>
class Animal {
public:
  virtual void speak() { printf("...\\n"); }
};
class Dog : public Animal {
public:
  virtual void speak() { printf("Woof\\n"); }
};
class Puppy : public Dog {
public:
  virtual void speak() { printf("Yip\\n"); }
};
int main(void) {
  Animal a;
  Dog d;
  Puppy p;
  Animal *arr[3];
  arr[0] = &a; arr[1] = &d; arr[2] = &p;
  for (int i = 0; i < 3; i++) arr[i]->speak();
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout === '...\nWoof\nYip\n', 'inh4 three-level override chain', r.stdout),
});

add({
  name: 'inh5 non-virtual inherited method calling a virtual method via implicit this dispatches to the runtime override',
  files: singleCpp(`#include <stdio.h>
class Base {
public:
  virtual int compute() { return 1; }
  int doubled() { return compute() * 2; }
};
class Derived : public Base {
public:
  virtual int compute() { return 5; }
};
int main(void) {
  Base b;
  Derived d;
  printf("%d %d\\n", b.doubled(), d.doubled());
  return 0;
}`),
  entry: 'main.cpp',
  check: (r) => check(r.stdout.trim() === '2 10', 'inh5 virtual call from inherited non-virtual method', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
