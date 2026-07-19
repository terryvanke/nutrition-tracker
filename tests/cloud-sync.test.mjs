import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

for (const collection of ['profile', 'settings', 'foodLogs', 'waterLogs', 'bodyRecords', 'foods']) {
  assert.match(app, new RegExp(`['"]${collection}['"]`), `missing normalized collection: ${collection}`);
}
assert.doesNotMatch(app.match(/async function saveToCloud\(\)[\s\S]*?\n\}/)?.[0] || '', /appState/,
  'saveToCloud must not write a monolithic appState blob');
assert.match(app, /replaceRemoteCollection\('foodLogs'/,
  'food logs must be synchronized by date document');
assert.match(app, /replaceRemoteCollection\('bodyRecords'/,
  'body records must be synchronized by record document');
assert.match(app, /remoteLastModified > localLastModified/,
  'cloud loading must resolve newer-remote conflicts');
assert.match(app, /localLastModified > remoteLastModified/,
  'cloud loading must resolve newer-local conflicts');
assert.doesNotMatch(rules, /allow create, update:[^;]*appState/s,
  'new legacy appState writes must be forbidden');

console.log('PASS normalized cloud sync architecture tests');
