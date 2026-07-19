import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(app, /data:\s*sanitizePersistedState\(state\)/,
  'exports must use sanitized state');
assert.match(app, /file\.size > 5 \* 1024 \* 1024/,
  'imports must enforce a size limit');
assert.match(app, /parsed\.format !== 'nutriai-export'/,
  'imports must validate the file format');
assert.match(app, /const imported = migrateState\(parsed\.data\)/,
  'imports must pass through schema migration');
assert.match(app, /for \(const name of \['profile', 'settings', 'foodLogs', 'waterLogs', 'bodyRecords', 'foods'\]\)/,
  'cloud deletion must cover every normalized collection');
assert.match(app, /await currentUser\.delete\(\)/,
  'account deletion must delete the Firebase Auth account');
assert.match(app, /auth\/requires-recent-login/,
  'account deletion must handle recent-login protection');
assert.match(html, /id="data-import-file"[^>]+accept="application\/json,.json"/,
  'the import picker must only offer JSON files');
assert.match(html, /data-action="deleteAccountAndData\(\)"/,
  'account deletion must be exposed explicitly');

console.log('PASS data management architecture tests');
