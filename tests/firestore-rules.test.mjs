import assert from 'node:assert/strict';
import fs from 'node:fs';

const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

assert.match(rules, /request\.auth != null && request\.auth\.uid == userId/,
  'rules must require the authenticated owner');
assert.doesNotMatch(rules, /allow\s+(?:read|write|read,\s*write)\s*:\s*if\s+true/,
  'rules must not contain public access');
assert.match(rules, /keys\(\)\.hasOnly/,
  'writes must reject unknown fields');
assert.match(rules, /match \/foodLogs\/\{date\}/,
  'food logs require a dedicated collection rule');
assert.match(rules, /match \/waterLogs\/\{date\}/,
  'water logs require a dedicated collection rule');
assert.match(rules, /match \/bodyRecords\/\{recordId\}/,
  'body records require a dedicated collection rule');
assert.match(rules, /match \/foods\/\{foodId\}/,
  'custom foods require a dedicated collection rule');
assert.match(rules, /entries\.size\(\) <= 100/,
  'food log size must be bounded');
assert.match(rules, /request\.resource\.data\.name\.size\(\) <= 100/,
  'food names must be bounded');

console.log('PASS Firestore rule policy tests');
