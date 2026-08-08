// Like run.mjs, but for WASM_USE_GC=true output: no NonGC shim needed (real
// WASM-GC modules are self-contained), so this just instantiates with an
// empty import object.
// Usage: node run-gc.mjs <ClassName> <exportedFn> [args...]
import { chromium } from 'playwright';
import fs from 'fs';

const [, , className, fnName, ...rawArgs] = process.argv;
if (!className || !fnName) {
  console.error('Usage: node run-gc.mjs <ClassName> <exportedFn> [args...]');
  process.exit(2);
}
const args = rawArgs.map(Number);
const wasmBytes = fs.readFileSync(`out/${className}.wasm`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const html = `<!DOCTYPE html><html><body><script>
window.__run = async (bytesArray, fnName, fnArgs) => {
  const bytes = new Uint8Array(bytesArray);
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const fn = instance.exports[fnName];
    const result = fn(...fnArgs);
    return { ok: true, result: typeof result === 'bigint' ? result.toString() : result };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
};
</script></body></html>`;
await page.setContent(html);
const result = await page.evaluate(
  async ([b, fn, a]) => await window.__run(b, fn, a),
  [Array.from(wasmBytes), fnName, args],
);
console.log(JSON.stringify(result));
await browser.close();
