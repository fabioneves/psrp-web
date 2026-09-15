import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node scripts/build-web.mjs <source> <output>');

const entries = await readdir(source, { recursive: true, withFileTypes: true });
const files = new Map();
for (const entry of entries.filter(entry => entry.isFile())) {
  const path = relative(source, join(entry.parentPath, entry.name));
  files.set(path, await readFile(join(source, path)));
}
const hash = createHash('sha256').update(await readFile(new URL(import.meta.url)));
for (const path of [...files.keys()].sort()) hash.update(path).update('\0').update(files.get(path)).update('\0');
const prefix = `/assets/${hash.digest('hex').slice(0, 20)}`;

await cp(source, output, { recursive: true });
for (const [path, bytes] of files) {
  const destination = path.endsWith('.html') ? join(output, path) : join(output, prefix, path);
  const content = /\.(html|js|css)$/.test(path)
    ? bytes.toString().replace(/(["'])(\/[^"'\s]+)\1/g, (match, quote, url) =>
      files.has(url.slice(1)) ? `${quote}${prefix}${url}${quote}` : match)
    : bytes;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
