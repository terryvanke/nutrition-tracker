import assert from 'node:assert/strict';
import * as api from '../src/data-model.js';

const defaults = api.createDefaultState();
assert.equal(defaults._schemaVersion, 2);
assert.deepEqual(defaults.historyLogs, {});
assert.deepEqual(defaults.bodyRecords, []);

const migrated = api.migrateState({
  apiConfig: { provider: 'deepseek', model: 'deepseek-chat', url: 'https://api.deepseek.com', key: 'SECRET' },
  usda_key: 'USDA_SECRET',
  currentMeal: 'invalid',
  historyRange: 999,
  historyLogs: { '2026-07-15': [{ total: { kcal: 100 } }] },
  bodyRecords: 'invalid',
  unknownField: 'must be removed'
});

assert.equal(migrated._schemaVersion, 2);
assert.equal(migrated.currentMeal, 'breakfast');
assert.equal(migrated.historyRange, 30);
assert.deepEqual(migrated.bodyRecords, []);
assert.equal('unknownField' in migrated, false);
assert.equal('key' in migrated.apiConfig, false);
assert.equal('usda_key' in migrated, false);

const persisted = api.persistentState({
  historyLogs: { '2026-07-15': [] },
  todayLog: [{ meal: 'lunch' }],
  pendingFoods: { foods: [] }
});
assert.deepEqual(persisted.todayLog, []);
assert.equal(persisted.pendingFoods, null);

console.log('PASS data model migration tests');
