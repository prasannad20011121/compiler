import { Preprocessor, type FileResolver } from '../preprocessor.ts';
import { Parser } from '../parser.ts';
import type { TopDecl } from '../ast.ts';
import { typeName } from '../types.ts';

const resolver: FileResolver = {
  resolveQuoted: () => undefined,
  resolveAngle: () => undefined,
};

let ok = true;
function check(cond: boolean, label: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) ok = false;
}

function parse(src: string): TopDecl[] {
  const pp = new Preprocessor(resolver);
  const toks = pp.preprocessFile(src, 't.c');
  const p = new Parser(toks);
  return p.parseTranslationUnit();
}

// 1. Simple function with arithmetic + control flow
{
  const decls = parse(`
    int add(int a, int b) {
      int sum = a + b;
      if (sum > 10) {
        return sum * 2;
      } else {
        return sum;
      }
    }
  `);
  check(decls.length === 1 && decls[0].kind === 'FunctionDecl', 'parses a function definition');
  const fn = decls[0] as any;
  check(fn.name === 'add', 'function name');
  check(fn.type.params.length === 2, 'two params');
  check(fn.body.body.length === 2, 'two statements in body (decl + if)');
}

// 2. Pointers, arrays, and the classic (*a)[3] declarator puzzle
{
  const decls = parse(`
    int global_arr[10];
    int *ptr_to_int;
    int (*ptr_to_array)[3];
    int *array_of_ptr[3];
  `);
  const byName = Object.fromEntries(decls.map((d: any) => [d.name, d]));
  check(byName.global_arr.type.kind === 'array' && byName.global_arr.type.arrayLen === 10, 'int[10]');
  check(byName.ptr_to_int.type.kind === 'pointer', 'int*');
  check(
    byName.ptr_to_array.type.kind === 'pointer' && byName.ptr_to_array.type.pointee.kind === 'array' && byName.ptr_to_array.type.pointee.arrayLen === 3,
    `int (*)[3]: got ${typeName(byName.ptr_to_array.type)}`,
  );
  check(
    byName.array_of_ptr.type.kind === 'array' && byName.array_of_ptr.type.pointee.kind === 'pointer',
    `int*[3]: got ${typeName(byName.array_of_ptr.type)}`,
  );
}

// 3. Self-referential struct (linked list) — the placeholder-mutation fix
{
  const decls = parse(`
    struct Node {
      int val;
      struct Node *next;
    };
    struct Node make(void) {
      struct Node n;
      n.val = 1;
      n.next = 0;
      return n;
    }
  `);
  const fn = decls.find((d: any) => d.kind === 'FunctionDecl') as any;
  const declStmt = fn.body.body[0];
  const nodeType = declStmt.decls[0].type;
  check(nodeType.fields.length === 2, `struct Node has 2 fields, got ${nodeType.fields?.length}`);
  const nextField = nodeType.fields.find((f: any) => f.name === 'next');
  check(nextField.type.kind === 'pointer', 'next is a pointer');
  check(
    nextField.type.pointee.fields && nextField.type.pointee.fields.length === 2,
    `self-referential pointer sees completed struct (fields=${JSON.stringify(nextField.type.pointee.fields?.map((f: any) => f.name))})`,
  );
}

// 4. typedef + enum + for loop + array initializer
{
  const decls = parse(`
    typedef unsigned int uint32;
    enum Color { RED, GREEN, BLUE = 5, YELLOW };
    uint32 table[4] = { RED, GREEN, BLUE, YELLOW };
    int sum_table(void) {
      int total = 0;
      for (int i = 0; i < 4; i = i + 1) {
        total = total + table[i];
      }
      return total;
    }
  `);
  const table = decls.find((d: any) => d.name === 'table') as any;
  check(table.type.kind === 'array' && table.type.pointee.kind === 'uint', `uint32 typedef resolved: ${typeName(table.type)}`);
  check(table.init.kind === 'InitList' && table.init.items.length === 4, 'array initializer list parsed');
  const fn = decls.find((d: any) => d.name === 'sum_table') as any;
  const forStmt = fn.body.body[1];
  check(forStmt.kind === 'For' && forStmt.cond.op === '<', 'for-loop parsed with init/cond/step');
}

// 5. Full expression precedence chain + casts + sizeof
{
  const decls = parse(`
    int f(void) {
      int x = 1 + 2 * 3 - (4 / 2) % 3;
      int y = (int)3.5 + sizeof(int) - sizeof x;
      int z = x > 0 ? x : -x;
      return x && y || !z;
    }
  `);
  const fn = decls[0] as any;
  check(fn.body.body.length === 4, `4 statements parsed, got ${fn.body.body.length}`);
  const yInit = fn.body.body[1].decls[0].init;
  check(yInit.kind === 'Binary' && yInit.op === '-', `cast/sizeof expression parses: ${yInit.kind}`);
}

if (!ok) throw new Error('parser smoke test failed');
console.log('ALL PASS');
