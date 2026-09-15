import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('web builds version the complete asset graph and preserve API URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-play-web-'));
  try {
    const source = join(directory, 'source');
    const output = join(directory, 'output');
    await mkdir(source);
    await writeFile(join(source, 'index.html'), '<script src="/app.js"></script><link href="/style.css">');
    await writeFile(join(source, 'app.js'), "import './dependency.js'; new Worker('/worker.js'); fetch('/api/auth/session');");
    await writeFile(join(source, 'worker.js'), "importScripts('/dependency.js');");
    await writeFile(join(source, 'dependency.js'), 'globalThis.ready = true;');
    await writeFile(join(source, 'style.css'), 'body { color: white; }');
    const build = async () => {
      execFileSync(process.execPath, ['scripts/build-web.mjs', source, output]);
      return readFile(join(output, 'index.html'), 'utf8');
    };
    const html = await build();
    const prefix = html.match(/src="(\/assets\/[a-f0-9]+)\/app.js"/)[1];
    assert.ok(html.includes(`href="${prefix}/style.css"`));
    const app = await readFile(join(output, prefix, 'app.js'), 'utf8');
    assert.ok(app.includes("import './dependency.js'"));
    assert.ok(app.includes(`new Worker('${prefix}/worker.js')`));
    assert.ok(app.includes("fetch('/api/auth/session')"));
    assert.ok((await readFile(join(output, prefix, 'worker.js'), 'utf8')).includes(`${prefix}/dependency.js`));
    assert.equal(await build(), html);
    await writeFile(join(source, 'dependency.js'), 'globalThis.ready = false;');
    assert.notEqual(await build(), html);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
