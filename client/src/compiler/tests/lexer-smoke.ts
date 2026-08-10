import { tokenize } from '../lexer';

const src = `
int main(void) {
  // comment
  int x = 0x1F + 3.14f; /* block
  comment */
  char *s = "hi\\n\\"q\\""; // string with escapes
  char c = 'a';
  return x != 0 ? 1 : 2;
}
`;

const toks = tokenize(src, 'test.c');
const kinds = toks.map((t) => `${t.kind}:${t.text}`).join(' ');
console.log(kinds);

const assertions: [boolean, string][] = [
  [toks.some((t) => t.kind === 'num' && t.text === '0x1F'), 'hex literal'],
  [toks.some((t) => t.kind === 'num' && t.text === '3.14f'), 'float literal with suffix'],
  [toks.some((t) => t.kind === 'string' && t.value === 'hi\n"q"'), 'string escapes'],
  [toks.some((t) => t.kind === 'char' && t.value === 'a'), 'char literal'],
  [toks.some((t) => t.kind === 'punct' && t.text === '!='), '!= punctuator'],
  [toks[toks.length - 1].kind === 'eof', 'ends with eof'],
];

let ok = true;
for (const [cond, label] of assertions) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}
if (!ok) throw new Error('lexer smoke test failed');
console.log('ALL PASS');
