const LIMITS = {
  weight_g: [0.1, 10000], kcal: [0, 20000], protein_g: [0, 2000],
  fat_g: [0, 2000], carbs_g: [0, 5000], fiber_g: [0, 1000]
};

export function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function nutritionNumber(food, key) {
  const [minimum, maximum] = LIMITS[key];
  const value = boundedNumber(food[key], minimum, maximum);
  if (value === null) throw new Error(`AI 返回的 ${key} 数值无效`);
  return Math.round(value * 10) / 10;
}

export function validateNutritionResponse(input) {
  if (!input || !Array.isArray(input.foods) || input.foods.length < 1 || input.foods.length > 50) {
    throw new Error('AI 返回的食物列表无效');
  }
  const foods = input.foods.map((food, index) => {
    if (!food || typeof food !== 'object') throw new Error(`第 ${index + 1} 项食物无效`);
    const name = String(food.name || '').trim();
    if (!name || name.length > 100) throw new Error(`第 ${index + 1} 项食物名称无效`);
    return {
      name,
      name_en: String(food.name_en || '').slice(0, 100),
      weight_g: nutritionNumber(food, 'weight_g'),
      kcal: nutritionNumber(food, 'kcal'),
      protein_g: nutritionNumber(food, 'protein_g'),
      fat_g: nutritionNumber(food, 'fat_g'),
      carbs_g: nutritionNumber(food, 'carbs_g'),
      fiber_g: nutritionNumber(food, 'fiber_g'),
      note: String(food.note || '').slice(0, 300)
    };
  });
  const total = foods.reduce((sum, food) => {
    sum.kcal += food.kcal; sum.protein_g += food.protein_g; sum.fat_g += food.fat_g;
    sum.carbs_g += food.carbs_g; sum.fiber_g += food.fiber_g;
    return sum;
  }, { kcal:0, protein_g:0, fat_g:0, carbs_g:0, fiber_g:0 });
  for (const key of Object.keys(total)) total[key] = Math.round(total[key] * 10) / 10;
  return { foods, total };
}
