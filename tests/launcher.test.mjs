import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [cmd, launcher, gitignore, readme] = await Promise.all([
  readFile('start-nutriai.cmd', 'utf8'),
  readFile('scripts/start-nutriai.ps1', 'utf8'),
  readFile('.gitignore', 'utf8'),
  readFile('README.md', 'utf8')
]);

assert.match(cmd, /ExecutionPolicy Bypass -File/);
assert.match(cmd, /scripts\\start-nutriai\.ps1/);
assert.match(launcher, /nodeVersion = '22\.12\.0'/);
assert.match(launcher, /https:\/\/nodejs\.org\/dist/);
assert.match(launcher, /pnpm install --frozen-lockfile/);
assert.match(launcher, /127\.0\.0\.1:4173/);
assert.match(launcher, /--strictPort/);
assert.match(gitignore, /^\.runtime\/$/m);
assert.match(readme, /start-nutriai\.cmd/);

console.log('PASS Windows one-click launcher tests');
