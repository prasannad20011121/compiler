# The compiler

A from-scratch C/C++ compiler that emits WebAssembly directly. No LLVM, no
clang, no binaryen/wabt, no vendored toolchain — every stage below is
hand-written in this directory and runs in-browser as part of the app
bundle (see `../workers/cpp-runner.worker.ts`).

## Pipeline

```
source text
  -> lexer.ts          tokenize
  -> preprocessor.ts    macro expansion, #if/#ifdef, #include (workspace files only)
  -> parser.ts           recursive-descent parser -> AST (ast.ts) + resolved types (types.ts)
  -> codegen.ts          fused type-checking + WASM codegen (wasm/module.ts, wasm/opcodes.ts)
  -> driver.ts            merges every translation unit + runtime/libc.ts into ONE
                           whole-program WASM module (no linker — everything is
                           parsed and code-generated together)
```

Whole-program compilation is the key simplification that makes the rest of
this tractable without a linker: `driver.ts` preprocesses and parses every
`.c`/`.cpp` file in the workspace plus our own runtime library
(`runtime/libc.ts`, written in C and compiled by this same compiler — true
self-hosting), then code-generates all of it into a single `.wasm` module.

Runtime memory layout: a data segment (string/global literals) at the
bottom, then a fixed-size shadow stack (grows down via a WASM global,
`__stack_ptr`), then the heap (bump allocator, grows via `memory.grow`).
Every C local — including scalars — lives in this linear-memory stack
frame rather than a native WASM local, which is what makes taking the
address of any local (`&x`) trivially correct; WASM locals are used only
for expression-evaluation scratch registers.

## What's supported

**C**: the practical bulk of C17 — all control flow (`if`/`while`/`do`/
`for`/`switch` with fallthrough, correctly running a `for` loop's step on
`continue`), full operator precedence and the usual arithmetic
conversions, structs/unions/enums (enum constants work as ordinary
compile-time-constant expressions, not just in their own declaration)/
typedefs, pointers and pointer arithmetic, arrays (incl. multi-dimensional
and `char buf[] = "literal"`-style inferred sizes), `static` locals (real
persistent storage, initialized once — not re-run per call), function
pointers including *indirect calls* through one (a real WASM table +
`call_indirect`, not just storing the value), user-defined variadic
functions (`#include <stdarg.h>` — `va_list`/`va_start`/`va_arg`/`va_end`
all work, alongside the `printf`-style calling convention they share), and
a self-hosted libc subset (`runtime/libc.ts`): `string.h`, a bump allocator
(`malloc`/`free`/`calloc`/`realloc` — `free` does not reclaim memory, which
is fine for the short programs this IDE runs), and `printf`/`sprintf`/
`scanf` with width/precision/padding flags and correct decimal rounding.

**C++**: classes/structs with fields and methods (implicit `this`,
including calling one method from another without an explicit `this->`),
constructors (including member-initializer lists, `Ctor(x) : field(x) {}`,
which also correctly call a class-typed member's own constructor rather
than just assigning it), destructors, `new`/`delete`, both ways of
constructing an object — as a declaration (`ClassName obj(args);`) and as
an expression (`ClassName(args)`, e.g. `return Vector2D(x + o.x, y + o.y);`)
— and references (`int &r = x;`, reference parameters and return values,
including using a reference-returning call as an assignment target).

## Known gaps (by design, not oversight)

These are documented scope cuts, not bugs — each would be a substantial
feature in its own right:

- **No inheritance, virtual functions, or vtables.** A `class Derived :
  public Base` base-clause parses (and is ignored) so it doesn't break
  unrelated code, but members/methods aren't inherited.
- **No operator overloading** — so no `std::cout <<` / iostream. Use
  `printf`/`scanf` (fully supported) in C++ files too.
- **No rvalue references** (`T&&`) — only ordinary lvalue references.
- **No templates, exceptions, or namespaces** beyond parsing-and-ignoring.
- **No function/method overloading** — one function per name; a second
  definition silently replaces the first at the WASM level.
- **No automatic destructor calls at scope exit** (no RAII) — destructors
  only run via explicit `delete`.
- **No out-of-class method definitions** (`ClassName::method() { ... }`);
  methods must be defined inline in the class body.
- **No `new T[n]`** (array-new) — only single-object `new`.
- **Designated initializers**, **compound literals**, and **`goto`/labels**
  are not implemented.
- Global variable initializers must be compile-time constants (covers the
  vast majority of real code, but e.g. `int x = some_function();` at file
  scope isn't supported).

## Testing

`tests/*-smoke.ts` compile real programs and execute the resulting WASM in
Node to check actual output, not just that parsing succeeds. Run any of
them with `tests/run.sh tests/<name>.ts` (bundles via esbuild, the same
way the app itself is built, then runs with plain `node`). Beyond the
unit-style suites (lexer/parser/preprocessor/wasm/codegen/driver),
`tests/battery-smoke.ts`, `tests/battery2-c-smoke.ts`, and
`tests/battery2-cpp-smoke.ts` are batteries of 90+ complete real programs
(single- and multi-file, simple through fairly advanced — sorting
algorithms, BSTs, backtracking, multi-file modules with shared headers,
classes composing classes) — this is what's actually caught most of the
real bugs during development, well beyond what hand-picked unit tests find.
