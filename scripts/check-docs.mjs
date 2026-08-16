import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const required = [
  'README.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'docs/ARCHITECTURE.md',
  'docs/STATUS.md',
];

const markdownFiles = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(path);
  }
}

for (const path of required) await access(resolve(root, path));
await collect(root);

const failures = [];
for (const file of markdownFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = resolve(dirname(file), decodeURIComponent(match[1]));
    try {
      await access(target);
    } catch {
      failures.push(`${file.slice(root.length + 1)} -> ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken local Markdown links:\n${failures.join('\n')}`);
  process.exitCode = 1;
}
