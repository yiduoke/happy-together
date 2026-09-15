// The ffmpeg WASM core (~31 MB) decodes AC3/E-AC3/DTS/TrueHD, which no browser
// ships. Copy it out of node_modules at build time so the binary never lives
// in git but is still served same-origin (a cross-origin worker is blocked).
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dest = join(process.cwd(), 'public', 'ffmpeg');
await mkdir(dest, { recursive: true });

// pnpm nests real packages under .pnpm, but node_modules/<pkg> symlinks there.
const copyDist = async (pkg, files) => {
  const dir = join(process.cwd(), 'node_modules', pkg, 'dist', 'esm');
  if (!existsSync(dir)) throw new Error(`missing ${pkg} dist — run install first`);
  for (const name of files) {
    const from = join(dir, name);
    if (existsSync(from)) await cp(from, join(dest, name));
  }
};

await copyDist('@ffmpeg/core', ['ffmpeg-core.js', 'ffmpeg-core.wasm']);
await copyDist('@ffmpeg/ffmpeg', ['worker.js']);
console.log('ffmpeg core copied to public/ffmpeg');
