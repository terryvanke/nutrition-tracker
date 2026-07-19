export const DATA_SCHEMA_VERSION = 2;

export function createDefaultState() {
  return {
    _schemaVersion: DATA_SCHEMA_VERSION,
    _lastModified: 0,
    profile: null,
    bmr: 0,
    tdee: 0,
    targetKcal: 0,
    apiConfig: null,
    todayLog: [],
    historyLogs: {},
    waterLogs: {},
    waterGoal: null,
    pendingFoods: null,
    currentMeal: 'breakfast',
    historyRange: 30,
    fitnessGoal: null,
    bodyRecords: [],
    bodyChartRange: 30,
    foodDb: []
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function migrateState(input) {
  const source = isPlainObject(input) ? input : {};
  const next = createDefaultState();
  const scalarFields = [
    'profile', 'bmr', 'tdee', 'targetKcal', 'apiConfig', 'waterGoal',
    'currentMeal', 'historyRange', 'fitnessGoal', 'bodyChartRange', '_lastModified'
  ];
  for (const key of scalarFields) {
    if (source[key] !== undefined) next[key] = source[key];
  }
  next.historyLogs = isPlainObject(source.historyLogs) ? source.historyLogs : {};
  next.waterLogs = isPlainObject(source.waterLogs) ? source.waterLogs : {};
  next.bodyRecords = Array.isArray(source.bodyRecords) ? source.bodyRecords : [];
  next.foodDb = Array.isArray(source.foodDb) ? source.foodDb : [];
  next.todayLog = Array.isArray(source.todayLog) ? source.todayLog : [];
  next.pendingFoods = null;

  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(next.currentMeal)) {
    next.currentMeal = 'breakfast';
  }
  if (![7, 30].includes(Number(next.historyRange))) next.historyRange = 30;
  if (![0, 7, 30, 90].includes(Number(next.bodyChartRange))) next.bodyChartRange = 30;
  if (next.apiConfig) {
    next.apiConfig = {
      provider: String(next.apiConfig.provider || 'deepseek'),
      model: String(next.apiConfig.model || ''),
      url: String(next.apiConfig.url || '')
    };
  }
  next._schemaVersion = DATA_SCHEMA_VERSION;
  return next;
}

export function persistentState(source) {
  const clean = migrateState(source);
  clean.todayLog = [];
  clean.pendingFoods = null;
  return clean;
}
