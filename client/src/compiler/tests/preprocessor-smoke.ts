import { Preprocessor, type FileResolver } from '../preprocessor.ts';

function spell(tokens: { text: string }[]): string {
  return tokens.map((t) => t.text).join(' ');
}

const files: Record<string, string> = {
  'util.h': `
    #define SQUARE(x) ((x) * (x))
    int helper(void);
  `,
};

const resolver: FileResolver = {
  resolveQuoted: (spec) => (files[spec] !== undefined ? { path: spec, text: files[spec] } : undefined),
  resolveAngle: () => undefined, // system headers are no-ops
};

let ok = true;
function check(cond: boolean, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}

// 1. object-like + function-like macros, nested expansion
{
  const pp = new Preprocessor(resolver);
  const src = `
    #define WIDTH 10
    #define AREA(w, h) ((w) * (h))
    int a = AREA(WIDTH, 2);
  `;
  const toks = pp.preprocessFile(src, 'a.c');
  const s = spell(toks);
  check(s.includes('( ( 10 ) * ( 2 ) )'), `function-like macro expansion: ${s}`);
}

// 2. #include "util.h" resolves against the file map, and its macro is usable afterward
{
  const pp = new Preprocessor(resolver);
  const src = `
    #include "util.h"
    int x = SQUARE(5);
  `;
  const toks = pp.preprocessFile(src, 'main.c');
  const s = spell(toks);
  check(s.includes('int helper ( void ) ;'), `included declaration present: ${s}`);
  check(s.includes('( ( 5 ) * ( 5 ) )'), `macro from included header expanded: ${s}`);
}

// 3. #ifdef/#else/#endif branch selection
{
  const pp = new Preprocessor(resolver);
  const src = `
    #define FOO
    #ifdef FOO
    int branch = 1;
    #else
    int branch = 2;
    #endif
  `;
  const s = spell(pp.preprocessFile(src, 'b.c'));
  check(s.includes('branch = 1'), `#ifdef true branch taken: ${s}`);
  check(!s.includes('branch = 2'), `#ifdef false branch dropped: ${s}`);
}

// 4. #if with arithmetic + defined()
{
  const pp = new Preprocessor(resolver);
  const src = `
    #define VERSION 3
    #if VERSION >= 2 && defined(VERSION)
    int ok = 1;
    #endif
    #if VERSION > 10
    int bad = 1;
    #endif
  `;
  const s = spell(pp.preprocessFile(src, 'c.c'));
  check(s.includes('ok = 1'), `#if arithmetic + defined(): ${s}`);
  check(!s.includes('bad = 1'), `#if false branch dropped: ${s}`);
}

// 5. unknown angle-bracket include is a silent no-op
{
  const pp = new Preprocessor(resolver);
  const src = `
    #include <stdio.h>
    int y = 1;
  `;
  const s = spell(pp.preprocessFile(src, 'd.c'));
  check(s.trim() === 'int y = 1 ;', `unknown system header skipped cleanly: '${s.trim()}'`);
}

// 6. recursive macro does not infinite-loop
{
  const pp = new Preprocessor(resolver);
  const src = `
    #define A B
    #define B A
    int z = A;
  `;
  const s = spell(pp.preprocessFile(src, 'e.c'));
  check(s.includes('z = A') || s.includes('z = B'), `self-recursive macro terminates: ${s}`);
}

if (!ok) throw new Error('preprocessor smoke test failed');
console.log('ALL PASS');
