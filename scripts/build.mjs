import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packageName = '@local/model-context-budget';
const read = file => readFile(resolve(root, file), 'utf8');
const manifest = JSON.parse(await read('package.json'));
const patch = JSON.parse(await read('cordis.patch.yml'));
if (manifest.name !== packageName
  || manifest.dsh.bundle.patch !== './cordis.patch.yml') throw new Error('Manifest mismatch');
if (!Array.isArray(patch) || patch.length !== 1 || Object.keys(patch[0]).join() !== 'insert'
  || patch[0].insert.length !== 1 || !patch[0].insert.every(entry => entry.id.startsWith(`${packageName}:`)
    && entry.name === packageName)) throw new Error('Invalid independent bundle patch');
const zh = JSON.parse(await read('locale/zh.json'));
const en = JSON.parse(await read('locale/en.json'));
if (JSON.stringify(Object.keys(zh.ui).sort()) !== JSON.stringify(Object.keys(en.ui).sort())) {
  throw new Error('Locale keys do not match');
}
const source = await read('src/client.js');
if (!source.startsWith('export function createClientPlugin')) throw new Error('Unexpected client entry');
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.js'), await read('src/host.js'));
await writeFile(resolve(root, 'dist/budget.js'), await read('src/budget.js'));
await writeFile(resolve(root, 'dist/client.js'), `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(packageName)},\n  factory(require) {\n${source.replace('export function createClientPlugin', 'function createClientPlugin')}\n    return createClientPlugin(require('react'), ${JSON.stringify(await read('src/client.css'))}, ${JSON.stringify({ zh: zh.ui, en: en.ui })});\n  },\n});\n`);
for (const file of ['dist/index.js', 'dist/budget.js', 'dist/client.js']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.stdout || result.error}`);
}
for (const target of ['.', './client', './icon']) {
  const path = resolve(root, manifest.exports[target]);
  if (!path.startsWith(`${root}/`)) throw new Error('Export leaves the package');
  await readFile(path);
}
console.log('Built Host, budget arithmetic and lazy Client entry; manifest, patch, locales and syntax checks passed.');
