import { ModuleBuilder } from '../wasm/module';
import { ValType } from '../wasm/opcodes';

// Hand-assemble: imported env.print_i32(i32); exported add(i32,i32)->i32;
// exported main() that computes add(2,3) and prints it, plus writes "hi" to memory
// and prints it via env.print_str(ptr, len).
const m = new ModuleBuilder();
const printI32 = m.importFunc('env', 'print_i32', [ValType.i32], []);
const printStr = m.importFunc('env', 'print_str', [ValType.i32, ValType.i32], []);

const add = m.declareFunc('add', [ValType.i32, ValType.i32], [ValType.i32]);
{
  const f = m.newFuncBuilder(add);
  f.localGet(0).localGet(1).op(0x6a); // i32.add
  m.defineFuncBody(add, f);
}

const main = m.declareFunc('main', [], []);
{
  const f = m.newFuncBuilder(main);
  f.i32Const(2).i32Const(3).call(add);
  f.call(printI32);
  f.i32Const(0).i32Const(2).call(printStr);
  m.defineFuncBody(main, f);
}

m.addData(0, new TextEncoder().encode('hi'));
m.exportFunc('main', main);
m.exportMemory('memory');

const bytes = m.finish();
console.log(`module size: ${bytes.length} bytes`);

const memory = new WebAssembly.Memory({ initial: 2 });
const outputs: string[] = [];
const { instance } = await WebAssembly.instantiate(bytes, {
  env: {
    print_i32: (v: number) => outputs.push(`i32:${v}`),
    print_str: (ptr: number, len: number) => {
      const bytes = new Uint8Array(
        (instance.exports.memory as WebAssembly.Memory).buffer,
        ptr,
        len,
      );
      outputs.push(`str:${new TextDecoder().decode(bytes)}`);
    },
  },
});

(instance.exports.main as Function)();
console.log('outputs:', outputs);

if (outputs.join(',') !== 'i32:5,str:hi') {
  throw new Error(`FAIL: unexpected outputs ${outputs}`);
}
console.log('PASS');
