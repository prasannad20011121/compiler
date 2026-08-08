import { chromium } from 'playwright';
import fs from 'fs';

const wasmBytes = fs.readFileSync('out/T26StdinWorkaround.wasm');
const shimJs = fs.readFileSync('out/T26StdinWorkaround.wasm.js', 'utf8');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

const html = `<!DOCTYPE html><html><body><script>
${shimJs}
window.__run = async (bytesArray, inputStr) => {
  const bytes = new Uint8Array(bytesArray);
  let output = '';
  let pos = 0;
  wasmImports.console = Object.assign({}, wasmImports.console, {
    putchar: (c) => { output += String.fromCharCode(c); },
    readbyte: () => (pos < inputStr.length ? inputStr.charCodeAt(pos++) : -1),
  });
  const { instance } = await WebAssembly.instantiate(bytes, wasmImports);
  const result = instance.exports.run(0);
  return { output, result };
};
</script></body></html>`;

await page.setContent(html);
const input = '42\nAda Lovelace\n';
const result = await page.evaluate(
  async ([bytesArray, input]) => await window.__run(bytesArray, input),
  [Array.from(wasmBytes), input],
);
console.log(JSON.stringify(result, null, 2));
await browser.close();
