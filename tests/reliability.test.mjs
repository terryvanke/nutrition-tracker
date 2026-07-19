import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDateKey, localDateKey } from '../src/utils/date.js';
import { boundedNumber, validateNutritionResponse } from '../src/validation/nutrition.js';

assert.equal(localDateKey(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
assert.equal(isDateKey('2024-02-29'), true);
assert.equal(isDateKey('2025-02-29'), false);
assert.equal(isDateKey('2026-13-01'), false);

assert.equal(boundedNumber('30', 30, 500), 30);
assert.equal(boundedNumber('-1', 0, 100), null);
assert.equal(boundedNumber('Infinity', 0, 100), null);
assert.equal(boundedNumber('101', 0, 100), null);

const validated = validateNutritionResponse({
  foods: [{
    name: '鸡蛋', name_en: 'egg', weight_g: 50, kcal: 70,
    protein_g: 6, fat_g: 5, carbs_g: 1, fiber_g: 0, note: '估算'
  }],
  total: { kcal: 999999 }
});
assert.equal(validated.total.kcal, 70, 'totals must be recalculated, not trusted');

for (const invalid of [
  { foods: [] },
  { foods: [{ name: '<script>', weight_g: -1, kcal: 1, protein_g: 1, fat_g: 1, carbs_g: 1, fiber_g: 1 }] },
  { foods: [{ name: 'x', weight_g: 1, kcal: Infinity, protein_g: 1, fat_g: 1, carbs_g: 1, fiber_g: 1 }] }
]) {
  assert.throws(() => validateNutritionResponse(invalid));
}

const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(app.match(/function getToday\(\)[\s\S]*?\n\}/)?.[0] || '', /toISOString/,
  'local date keys must not use UTC conversion');
assert.doesNotMatch(app, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  'empty catch blocks are forbidden');

console.log('PASS reliability boundary tests');
