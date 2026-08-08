// Verifies out/hello.wasm actually runs in a real browser: instantiates the
// module with the auto-generated NonGC JS shim (out/hello.wasm.js) plus a
// console.putchar we supply ourselves, calls the exported run(a, b), and
// checks both the printed text and the returned sum.
//
// Usage: node test/run.mjs [path-to-chromium]
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(scriptDir, '..', 'out');

const wasmBytes = fs.readFileSync(path.join(outDir, 'hello.wasm'));
const shimJs = fs.readFileSync(path.join(outDir, 'hello.wasm.js'), 'utf8');

const executablePath = process.argv[2] || process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

const html = `<!DOCTYPE html><html><body><script>
${shimJs}
window.__runTest = async (bytesArray) => {
  const bytes = new Uint8Array(bytesArray);
  let output = '';
  wasmImports.console = { putchar: (c) => { output += String.fromCharCode(c); } };
  const { instance } = await WebAssembly.instantiate(bytes, wasmImports);
  const sum = instance.exports.run(10, 5);
  return { output, sum };
};
</script></body></html>`;

await page.setContent(html);
const result = await page.evaluate(
  async (bytesArray) => await window.__runTest(bytesArray),
  Array.from(wasmBytes),
);
await browser.close();

const expectedOutput = 'Hello from Java via JWebAssembly!\nsum computed\n';
const expectedSum = 15;

console.log('output:', JSON.stringify(result.output));
console.log('sum:', result.sum);

if (result.output !== expectedOutput || result.sum !== expectedSum) {
  console.error('FAIL: output or return value did not match expectations');
  process.exit(1);
}
console.log('PASS');
