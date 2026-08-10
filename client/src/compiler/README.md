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
is fine for the short programs this IDE runs), `printf`/`sprintf`/`scanf`
with width/precision/padding flags and correct decimal rounding, and a
real `math.h` (`sqrt`/`fabs` compile to native WASM instructions;
`exp`/`log`/`sin`/`cos`/`tan`/`pow`/`floor`/`ceil`/`M_PI`/`M_E` are actual
numerical implementations — range reduction + Taylor series, Newton's
method for `log` — good to about 1e-12, not bit-for-bit libm but plenty
for this IDE's programs). Also **designated initializers** (`{.field = v}`,
`{[i] = v}`, C99 — out of order, with array-length inference from the
highest index reached) and **compound literals** (`(Type){...}`, usable
anywhere an expression is, including chained straight into
indexing/member-access/calls like `(int[]){1,2,3}[0]`), and **`goto`/
labels**: any function using them gets its top-level statement list
lowered into a `loop` + one nested `block` per label with a small dispatch
check, so labels declared at the top level of a function body support
both forward and backward `goto` (including `goto` from deep inside
nested loops — the common "break out of nested loops to a cleanup label"
pattern) — see the gaps list for the one restriction (labels must be
top-level; a `goto` itself can originate from anywhere).

**C++**: classes/structs with fields and methods (implicit `this`,
including calling one method from another without an explicit `this->`),
constructors (including member-initializer lists, `Ctor(x) : field(x) {}`,
which also correctly call a class-typed member's own constructor rather
than just assigning it), destructors, `new`/`delete`, both ways of
constructing an object — as a declaration (`ClassName obj(args);`) and as
an expression (`ClassName(args)`, e.g. `return Vector2D(x + o.x, y + o.y);`)
— and references (`int &r = x;`, reference parameters and return values,
including using a reference-returning call as an assignment target).

**Single inheritance & virtual functions**: `class Derived : public Base`
flattens the base's fields and methods into the derived type at parse time
(so inherited members are found by plain name lookup, no base-chain walk),
supports overriding, constructor base-init (`Derived(x) : Base(x) {}`),
and `virtual` methods dispatched through a real vtable (an array of
function indices in the data segment, indexed through the same
`call_indirect` table function pointers already use) — so calling a
virtual method through a base pointer/reference correctly runs the
most-derived override, including when the call originates from an
inherited non-virtual method. Classes with a vtable but no user-declared
constructor get a synthesized one purely to stamp the vtable pointer.
Multiple inheritance parses only the first base in the list (documented
gap, see below).

**Operator overloading**: `T operator+(U rhs)` (and `-`, `*`, `/`, `==`,
`!=`, `<`, `>`, `<=`, `>=`, unary `-`/`!`, and `operator[]`) as member
functions — `a + b` rewrites to `a.operator+(b)` at codegen time whenever
`a`'s type has a matching method, reusing the same method-call machinery
everything else goes through (so it works through inheritance, chains
(`a + b - c`), and `operator[]` returning `int&` gives real mutable
indexing via the reference machinery). Still one function per operator per
class — real C++'s operator overloading-via-overload-resolution (e.g.
distinct `operator+` for different right-hand-side types) doesn't apply.
No `operator()`, `operator=`, compound-assignment operators, or
conversion operators — see below.

## Known gaps (by design, not oversight)

These are documented scope cuts, not bugs — each would be a substantial
feature in its own right:

- **No multiple inheritance** — `class C : public A, public B` only keeps
  `A`; single inheritance only.
- **No virtual destructors / polymorphic `delete`** — `delete` always
  calls the statically-resolved destructor for the pointer's declared
  type, not a dynamically-dispatched one.
- Base-class field offsets can differ between a standalone base object and
  a base subobject embedded in a derived class, in the one case where a
  base with **no** virtual functions is extended by a derived class that
  introduces new ones (the derived class then needs its own vtable-pointer
  slot, shifting the inherited base fields by 4 bytes within the derived
  layout). Harmless unless something casts back to a `Base*` and reads a
  field through it in that specific scenario.
- **No `operator()`, `operator=`, compound-assignment operators
  (`+=` etc.), or conversion operators**, and no free-function operator
  overloads (`operator+(A, B)` outside a class) — so no `std::cout <<` /
  iostream either. Use `printf`/`scanf` (fully supported) in C++ files too.
- **No rvalue references** (`T&&`) — only ordinary lvalue references.
- **No templates, exceptions, or namespaces** beyond parsing-and-ignoring.
- **No function/method overloading** — one function per name; a second
  definition silently replaces the first at the WASM level.
- **No automatic destructor calls at scope exit** (no RAII) — destructors
  only run via explicit `delete`.
- **No out-of-class method definitions** (`ClassName::method() { ... }`);
  methods must be defined inline in the class body.
- **No `new T[n]`** (array-new) — only single-object `new`.
- **`goto` labels must be declared at the top level of the function body**
  (not nested inside an `if`/loop/`switch`) — covers early-exit/cleanup,
  retry loops, and breaking out of nested loops (by far the most common
  real-world uses), but not jumping into the middle of an arbitrarily
  nested block. The `goto` itself has no such restriction.
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
`tests/references-smoke.ts`, `tests/inheritance-smoke.ts`,
`tests/operators-smoke.ts`, `tests/designated-init-smoke.ts`, and
`tests/mathgoto-smoke.ts` cover the C++ reference,
single-inheritance/virtual-function, and operator-overloading features,
and the C designated-initializer/compound-literal and math.h/goto/label
features, respectively.
