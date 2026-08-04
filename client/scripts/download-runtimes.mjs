/**
 * Installs the pinned WASM language runtimes listed in runtimes.json into
 * public/runtimes/<name>/<version>/ so they are served same-origin.
 *
 * Two source kinds:
 *  - "node_modules": copy files from an exact-pinned npm package
 *    (integrity is already guaranteed by package-lock.json / `npm ci`).
 *  - "url": download a release artifact and verify its SHA-256 checksum.
 *    Fails hard on mismatch — never ship an unverified runtime.
 *
 * Run once per checkout (and in CI): `npm run runtimes`
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(scriptDir, '..');
const outRoot = path.join(clientRoot, 'public', 'runtimes');

const manifest = JSON.parse(await readFile(path.join(clientRoot, 'runtimes.json'), 'utf8'));
const entries = Object.entries(manifest.runtimes ?? {});

if (entries.length === 0) {
  console.log('runtimes.json has no runtimes yet — nothing to install.');
  process.exit(0);
}

for (const [name, spec] of entries) {
  const dest = path.join(outRoot, name, spec.version);
  const stamp = path.join(dest, '.complete');
  if (existsSync(stamp)) {
    console.log(`✓ ${name}@${spec.version} already present`);
    continue;
  }
  await mkdir(dest, { recursive: true });

  if (spec.source === 'node_modules') {
    const pkgRoot = path.join(clientRoot, 'node_modules', spec.package);
    const pkg = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
    if (pkg.version !== spec.version) {
      throw new Error(
        `${name}: node_modules has ${spec.package}@${pkg.version} but runtimes.json pins ${spec.version}. Run npm ci.`,
      );
    }
    for (const file of spec.files) {
      await copyFile(path.join(pkgRoot, file), path.join(dest, file));
      console.log(`  copied ${file}`);
    }
  } else if (spec.source === 'local') {
    // Files were placed here by a local build step (e.g. csharp-wasm-runtime/build.ps1).
    // Just verify the directory is non-empty and write the stamp.
    const localPath = path.join(clientRoot, spec.localPath ?? dest);
    if (!existsSync(localPath)) {
      throw new Error(
        `${name}: localPath '${localPath}' does not exist.\n` +
        `Run the build script first:\n  cd csharp-wasm-runtime && .\\build.ps1`,
      );
    }
    const files = await (await import('node:fs/promises')).readdir(localPath);
    if (files.length === 0) {
      throw new Error(`${name}: localPath '${localPath}' is empty. Run the build script first.`);
    }
    console.log(`✓ ${name}@${spec.version} present at ${localPath} (${files.length} files)`);
  } else if (spec.source === 'url-files') {
    for (const file of spec.files) {
      const target = path.join(dest, file.name);
      let bytes;
      if (existsSync(target)) {
        bytes = await readFile(target);
      } else {
        const url = spec.baseUrl + file.name;
        console.log(`↓ ${name}: ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${name}/${file.name}: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.sha256) {
        throw new Error(
          `${name}/${file.name}: SHA-256 mismatch!\n  expected ${file.sha256}\n  actual   ${digest}\nRefusing to install an unverified runtime.`,
        );
      }
      if (!existsSync(target)) await writeFile(target, bytes);
      console.log(`  ✓ ${file.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, checksum ok)`);
    }
  } else if (spec.source === 'url') {
    console.log(`↓ ${name}@${spec.version} from ${spec.url}`);
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`${name}: download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== spec.sha256) {
      throw new Error(
        `${name}: SHA-256 mismatch!\n  expected ${spec.sha256}\n  actual   ${digest}\nRefusing to install an unverified runtime.`,
      );
    }
    console.log(`  checksum ok (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    if (spec.archive) {
      throw new Error(`${name}: archive extraction not implemented yet`);
    }
    await writeFile(path.join(dest, path.basename(new URL(spec.url).pathname)), bytes);
  } else {
    throw new Error(`${name}: unknown source '${spec.source}'`);
  }

  await writeFile(stamp, new Date().toISOString());
  console.log(`✓ ${name}@${spec.version} installed`);
}

console.log('All runtimes present and verified.');
