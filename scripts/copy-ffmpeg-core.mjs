// The ffmpeg WASM core (~31 MB) decodes AC3/E-AC3/DTS/TrueHD, which no browser
// ships. Copy it out of node_modules at build time so the binary never lives
// in git but is still served same-origin (a cross-origin worker is blocked).
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dest = join(process.cwd(), 'public', 'ffmpeg');
await mkdir(dest, { recursive: true });

// pnpm nests real packages under .pnpm, but node_modules/<pkg> symlinks there.
// Passing no file list copies the whole ESM build: classes.js pulls in its
// siblings at runtime, so copying it alone yields a 404 on first use.
const copyDist = async (pkg, files) => {
  const dir = join(process.cwd(), 'node_modules', pkg, 'dist', 'esm');
  if (!existsSync(dir)) throw new Error(`missing ${pkg} dist — run install first`);
  const names = files ?? (await readdir(dir)).filter((n) => n.endsWith('.js'));
  for (const name of names) {
    const from = join(dir, name);
    if (!existsSync(from)) throw new Error(`missing ${pkg}/dist/esm/${name}`);
    await cp(from, join(dest, name));
  }
};

await copyDist('@ffmpeg/core', ['ffmpeg-core.js', 'ffmpeg-core.wasm']);
await copyDist('@ffmpeg/ffmpeg');
console.log('ffmpeg core copied to public/ffmpeg');
