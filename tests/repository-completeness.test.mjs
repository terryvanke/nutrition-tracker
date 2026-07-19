import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const file of [
  'README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'CHANGELOG.md', '.env.example', '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/pages.yml', 'vite.config.js'
]) {
  assert.equal(fs.existsSync(new URL(`../${file}`, import.meta.url)), true, `missing ${file}`);
}

const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
assert.match(gitignore, /^\.env$/m, '.env must be ignored');
assert.match(gitignore, /^node_modules\/$/m, 'dependencies must be ignored');
assert.match(gitignore, /^dist\/$/m, 'build output must be ignored');

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
for (const command of ['pnpm install --frozen-lockfile', 'pnpm test', 'pnpm test:rules', 'pnpm build']) {
  assert.ok(readme.includes(command), `README missing command: ${command}`);
}

console.log('PASS repository completeness tests');
