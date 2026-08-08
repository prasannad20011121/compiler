// Generic runner: node run.mjs <ClassName> <exportedFn> <arg1> <arg2> ...
// Args are parsed as numbers (int/float) unless they look like 'true'/'false'.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [, , className, fnName, ...rawArgs] = process.argv;
if (!className || !fnName) {
  console.error('Usage: node run.mjs <ClassName> <exportedFn> [args...]');
  process.exit(2);
}
const args = rawArgs.map((a) => (a === 'true' ? true : a === 'false' ? false : Number(a)));

const wasmPath = path.join(scriptDir, 'out', `${className}.wasm`);
const shimPath = path.join(scriptDir, 'out', `${className}.wasm.js`);
if (!fs.existsSync(wasmPath)) {
  console.error('NO WASM FILE:', wasmPath);
  process.exit(2);
}
const wasmBytes = fs.readFileSync(wasmPath);
const shimJs = fs.existsSync(shimPath) ? fs.readFileSync(shimPath, 'utf8') : '';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

const html = `<!DOCTYPE html><html><body><script>
${shimJs}
window.__run = async (bytesArray, fnName, fnArgs) => {
  const bytes = new Uint8Array(bytesArray);
  let stdout = '';
  if (typeof wasmImports === 'undefined') { window.wasmImports = {}; }
  wasmImports.console = Object.assign({}, wasmImports.console, { putchar: (c) => { stdout += String.fromCharCode(c); } });
  try {
    const { instance } = await WebAssembly.instantiate(bytes, wasmImports);
    const fn = instance.exports[fnName];
    if (!fn) return { ok: false, error: 'no export named ' + fnName, exports: Object.keys(instance.exports) };
    const result = fn(...fnArgs);
    return { ok: true, result: typeof result === 'bigint' ? result.toString() : result, stdout };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), stdout };
  }
};
</script></body></html>`;

await page.setContent(html);
const result = await page.evaluate(
  async ([bytesArray, fn, fnArgs]) => await window.__run(bytesArray, fn, fnArgs),
  [Array.from(wasmBytes), fnName, args],
);
await browser.close();
console.log(JSON.stringify(result));
