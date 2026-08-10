import { check, runBattery, single, type Case } from './harness';

const cases: Case[] = [];
function add(c: Case) {
  cases.push(c);
}

add({
  name: 'm1 sqrt/fabs/pow (integer + fractional exponent)',
  files: single(`#include <stdio.h>
#include <math.h>
int main(void) {
  double a = sqrt(64.0);
  double b = fabs(-12.5);
  double c = pow(2.0, 10.0);
  double d = pow(2.0, 0.5);
  printf("%.1f %.1f %.1f %.4f\\n", a, b, c, d);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '8.0 12.5 1024.0 1.4142', 'm1 sqrt/fabs/pow', r.stdout),
});

add({
  name: 'm2 exp/log round-trip and known values',
  files: single(`#include <stdio.h>
#include <math.h>
int main(void) {
  double e1 = exp(1.0);
  double l1 = log(exp(3.0));
  double l2 = log(1.0);
  printf("%.4f %.4f %.4f\\n", e1, l1, l2);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '2.7183 3.0000 0.0000', 'm2 exp/log', r.stdout),
});

add({
  name: 'm3 sin/cos/tan at well-known angles, using M_PI',
  files: single(`#include <stdio.h>
#include <math.h>
int main(void) {
  double s0 = sin(0.0);
  double c0 = cos(0.0);
  double s90 = sin(M_PI / 2.0);
  double c180 = cos(M_PI);
  printf("%.4f %.4f %.4f %.4f\\n", s0, c0, s90, c180);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '0.0000 1.0000 1.0000 -1.0000', 'm3 sin/cos at known angles', r.stdout),
});

add({
  name: 'm4 floor/ceil, including negative numbers',
  files: single(`#include <stdio.h>
#include <math.h>
int main(void) {
  printf("%.1f %.1f %.1f %.1f\\n", floor(3.7), ceil(3.2), floor(-3.2), ceil(-3.7));
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '3.0 4.0 -4.0 -3.0', 'm4 floor/ceil', r.stdout),
});

add({
  name: 'g1 goto used to break out of nested loops to a top-level label',
  files: single(`#include <stdio.h>
int main(void) {
  int i, j;
  int found_i = -1, found_j = -1;
  for (i = 0; i < 5; i++) {
    for (j = 0; j < 5; j++) {
      if (i * j == 12) {
        found_i = i;
        found_j = j;
        goto done;
      }
    }
  }
done:
  printf("%d %d\\n", found_i, found_j);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '3 4', 'g1 goto multi-level break', r.stdout),
});

add({
  name: 'g2 goto used as a backward-jumping retry loop',
  files: single(`#include <stdio.h>
int main(void) {
  int x = 100;
  int steps = 0;
retry:
  steps = steps + 1;
  if (x > 1) {
    x = x / 2;
    goto retry;
  }
  printf("%d %d\\n", x, steps);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '1 7', 'g2 goto backward retry loop', r.stdout),
});

add({
  name: 'g3 forward goto that skips code, then falls through subsequent labels',
  files: single(`#include <stdio.h>
int main(void) {
  int total = 0;
  goto second;
first:
  total = total + 1;
second:
  total = total + 10;
third:
  total = total + 100;
  printf("%d\\n", total);
  return 0;
}`),
  entry: 'main.c',
  check: (r) => check(r.stdout.trim() === '110', 'g3 forward goto + label fallthrough', r.stdout),
});

runBattery(cases).catch((e) => {
  console.error(e);
  process.exit(1);
});
