import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const listOnly = process.argv.includes('--list');
const requested = process.argv.slice(2).filter(argument => argument !== '--list');

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(target));
    else if (entry.name.endsWith('.test.js')) files.push(path.relative(root, target));
  }
  return files.sort();
}

const available = await testFiles(path.join(root, 'tests'));
const selected = new Set();
for (const request of requested.length ? requested : ['tests']) {
  const scope = request.replace(/\/$/, '');
  const prefix = scope === 'tests' || scope.startsWith('tests/') ? scope : `tests/${scope}`;
  const matches = available.filter(file => file === prefix || file.startsWith(`${prefix}/`));
  if (!matches.length) {
    console.error(`找不到测试分组或文件：${request}`);
    process.exit(1);
  }
  for (const file of matches) selected.add(file);
}
const files = [...selected].sort();
if (listOnly) {
  console.log(files.join('\n'));
} else {
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
