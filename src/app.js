// ============================================================
//  API CONSTANTS (must be defined before any function that uses them)
import { DATA_SCHEMA_VERSION, createDefaultState, migrateState, persistentState } from './data-model.js';
import { escapeHtml } from './utils/security.js';
import { localDateKey } from './utils/date.js';
import { boundedNumber, validateNutritionResponse } from './validation/nutrition.js';

// ============================================================
const API_ENDPOINTS = {
  openai:   'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  minimax:  'https://api.minimaxi.com/v1/chat/completions',
  zhipu:    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  qwen:     'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  moonshot: 'https://api.moonshot.cn/v1/chat/completions',
};
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini', deepseek: 'deepseek-chat',
  minimax: 'MiniMax-M2.7',
  zhipu: 'glm-4-flash', qwen: 'qwen-plus', moonshot: 'moonshot-v1-8k'
};
const MODEL_HINTS = {
  openai: 'gpt-4o / gpt-4o-mini / gpt-3.5-turbo',
  deepseek: 'deepseek-chat / deepseek-reasoner',
  minimax: 'MiniMax-M2.7 / MiniMax-M2.7-highspeed / MiniMax-M2.5',
  zhipu: 'glm-4-flash / glm-4-air / glm-4',
  qwen: 'qwen-plus / qwen-turbo / qwen-max',
  moonshot: 'moonshot-v1-8k / moonshot-v1-32k'
};

// Sensitive credentials are session-only. They must never enter application
// state, localStorage, logs, or cloud synchronization payloads.
const SECRET_KEYS = {
  ai: 'nutriai_secret_ai_key',
  usda: 'nutriai_secret_usda_key'
};

function getSecret(name) {
  return sessionStorage.getItem(SECRET_KEYS[name]) || '';
}

function setSecret(name, value) {
  if (value) sessionStorage.setItem(SECRET_KEYS[name], value);
  else sessionStorage.removeItem(SECRET_KEYS[name]);
}

function sanitizePersistedState(source) {
  const clean = persistentState(source);
  if (clean.apiConfig) delete clean.apiConfig.key;
  delete clean.usda_key;
  return clean;
}

// ============================================================
//  FIREBASE CLOUD SYNC
// ============================================================
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

let db = null;
let currentUser = null;
let isSyncing = false;
let syncDebounceTimer = null;
let authMode = 'login';        // 'login' | 'register'

function initFirebase() {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.appId) {
    console.info('Firebase is not configured; cloud sync is disabled.');
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    // Check for existing session
    firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        currentUser = user;
        updateSyncUI();
        loadFromCloud();
      } else {
        currentUser = null;
        updateSyncUI();
      }
    });
  } catch(e) {
    console.warn('Firebase init failed:', e);
  }
}

const PARSE_SYSTEM = `你是一个专业的营养分析 AI 助手。
用户会用自然语言描述他们吃了什么。你需要：
1. 识别并拆分所有食物
2. 估算每种食物的重量（单位：克）
3. 基于标准营养数据计算每种食物的营养成分

严格以 JSON 格式返回，不要有任何多余文字，格式如下：
{
  "foods": [
    {
      "name": "食物名称（中文）",
      "name_en": "English name",
      "weight_g": 估算重量(数字),
      "kcal": 热量(数字),
      "protein_g": 蛋白质克数(数字),
      "fat_g": 脂肪克数(数字),
      "carbs_g": 碳水化合物克数(数字),
      "fiber_g": 膳食纤维克数(数字),
      "note": "备注（如何估算重量的说明）"
    }
  ],
  "total": {
    "kcal": 总热量,
    "protein_g": 总蛋白质,
    "fat_g": 总脂肪,
    "carbs_g": 总碳水,
    "fiber_g": 总膳食纤维
  }
}

使用中国常见食物的标准营养数据，重量估算请基于常见份量（如：一个鸡蛋约50g，一碗米饭约200g，一杯牛奶约250ml等）。
所有数字保留一位小数。`;
// Firebase vars are defined above (before PARSE_SYSTEM), no duplicates here

function openAuthModal() {
  if (currentUser) {
    if (confirm('当前已登录为 ' + currentUser.email + '，是否退出登录？\n退出后数据仍保留在本地。')) {
      signOut();
    }
    return;
  }
  document.getElementById('auth-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeAuthModal() {
  document.getElementById('auth-overlay').classList.remove('show');
  document.body.style.overflow = '';
}

function toggleAuthMode() {
  if (authMode === 'login') {
    authMode = 'register';
    document.getElementById('auth-login-form').style.display = 'none';
    document.getElementById('auth-register-form').style.display = 'block';
    document.getElementById('auth-title').textContent = '📝 注册';
  } else {
    authMode = 'login';
    document.getElementById('auth-login-form').style.display = 'block';
    document.getElementById('auth-register-form').style.display = 'none';
    document.getElementById('auth-title').textContent = '🔐 登录';
  }
}

async function handleAuth() {
  if (!db) { toast('云同步服务未就绪', 'error'); return; }
  const btn = authMode === 'login'
    ? document.getElementById('auth-submit-btn')
    : document.getElementById('auth-reg-btn');
  btn.disabled = true;
  btn.textContent = '⏳ 请稍候...';

  try {
    if (authMode === 'login') {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      if (!email || !password) { toast('请填写邮箱和密码', 'error'); btn.disabled = false; btn.textContent = '登录'; return; }
      await firebase.auth().signInWithEmailAndPassword(email, password);
      toast('✅ 登录成功，正在同步数据...', 'success');
      closeAuthModal();
    } else {
      const email = document.getElementById('auth-reg-email').value.trim();
      const password = document.getElementById('auth-reg-password').value;
      const confirm = document.getElementById('auth-reg-confirm').value;
      if (!email || !password) { toast('请填写邮箱和密码', 'error'); btn.disabled = false; btn.textContent = '注册'; return; }
      if (password.length < 6) { toast('密码至少6位', 'error'); btn.disabled = false; btn.textContent = '注册'; return; }
      if (password !== confirm) { toast('两次密码不一致', 'error'); btn.disabled = false; btn.textContent = '注册'; return; }
      await firebase.auth().createUserWithEmailAndPassword(email, password);
      toast('✅ 注册成功！', 'success');
      closeAuthModal();
    }
  } catch(e) {
    const msg = e.code === 'auth/user-not-found' ? '账号不存在' :
                e.code === 'auth/wrong-password' ? '密码错误' :
                e.code === 'auth/email-already-in-use' ? '该邮箱已注册' :
                e.code === 'auth/weak-password' ? '密码至少6位' :
                e.code === 'auth/invalid-email' ? '邮箱格式不正确' :
                e.code === 'auth/invalid-credential' ? '邮箱或密码错误' :
                e.message;
    toast((authMode === 'login' ? '登录' : '注册') + '失败：' + msg, 'error');
  }
  btn.disabled = false;
  btn.textContent = authMode === 'login' ? '登录' : '注册';
}

async function signOut() {
  try {
    await firebase.auth().signOut();
  } catch(e) {
    console.warn('Sign out failed:', e?.code || e?.message || 'unknown error');
    toast('退出登录失败，请检查网络后重试', 'error');
    return;
  }
  currentUser = null;
  updateSyncUI();
  toast('已退出登录', '');
}

function updateSyncUI() {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (currentUser) {
    dot.className = 'sync-dot online';
    const email = currentUser.email || '';
    text.textContent = '☁️ ' + email;
  } else {
    dot.className = 'sync-dot offline';
    text.textContent = '☁️ 未登录（点击登录）';
  }
}

function setSyncingUI(syncing) {
  const dot = document.getElementById('sync-dot');
  if (syncing && currentUser) {
    dot.className = 'sync-dot syncing';
  } else if (currentUser) {
    dot.className = 'sync-dot online';
  }
}

function cloudMetadata() {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    clientUpdatedAt: state._lastModified || Date.now(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

function remoteTimestamp(data) {
  if (data?.updatedAt?.toMillis) return data.updatedAt.toMillis();
  return Number(data?.clientUpdatedAt) || 0;
}

async function replaceRemoteCollection(name, desiredDocuments) {
  const collection = db.collection('users').doc(currentUser.uid).collection(name);
  const existing = await collection.get();
  const desiredIds = new Set(Object.keys(desiredDocuments));
  const operations = [];
  existing.forEach(doc => {
    if (!desiredIds.has(doc.id)) operations.push({ type: 'delete', ref: doc.ref });
  });
  for (const [id, data] of Object.entries(desiredDocuments)) {
    operations.push({ type: 'set', ref: collection.doc(id), data });
  }
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 400)) {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
  }
}

function bodyRecordId(record, index) {
  return encodeURIComponent(record.id || `${record.date || 'record'}_${record.time || index}`);
}

// Upload normalized documents. Credentials never enter these payloads.
async function saveToCloud() {
  if (!db || !currentUser || isSyncing) return;
  try {
    isSyncing = true;
    setSyncingUI(true);
    state._lastModified = Date.now();
    const userRef = db.collection('users').doc(currentUser.uid);
    const meta = cloudMetadata();

    if (state.profile) {
      await userRef.collection('profile').doc('current').set({
        gender: state.profile.gender || 'male',
        age: Number(state.profile.age) || 0,
        height: Number(state.profile.height) || 0,
        weight: Number(state.profile.weight) || 0,
        goal: state.profile.goal || 'maintain',
        activity: Number(state.profile.activity) || 1.2,
        bmr: Number(state.bmr) || 0,
        tdee: Number(state.tdee) || 0,
        targetKcal: Number(state.targetKcal) || 0,
        ...meta
      });
    } else {
      await userRef.collection('profile').doc('current').delete().catch(() => {});
    }

    await userRef.collection('settings').doc('current').set({
      waterGoal: state.waterGoal ?? null,
      apiProvider: state.apiConfig?.provider || null,
      apiModel: state.apiConfig?.model || null,
      historyRange: Number(state.historyRange) || 30,
      bodyChartRange: Number(state.bodyChartRange) || 30,
      fitnessGoal: state.fitnessGoal || null,
      ...meta
    });

    const foodLogs = Object.fromEntries(Object.entries(state.historyLogs || {}).map(([date, entries]) => [
      date, { entries, ...meta }
    ]));
    const waterLogs = Object.fromEntries(Object.entries(state.waterLogs || {}).map(([date, log]) => [
      date, { total: Number(log.total) || 0, records: Array.isArray(log.records) ? log.records : [], ...meta }
    ]));
    const bodyRecords = Object.fromEntries((state.bodyRecords || []).map((record, index) => [
      bodyRecordId(record, index), {
        date: record.date || getToday(), weight: Number(record.weight) || 0,
        bodyFat: record.bodyFat ?? null, waist: record.waist ?? null,
        note: String(record.note || ''), time: record.time || new Date().toISOString(),
        ...meta
      }
    ]));
    const foods = Object.fromEntries((state.foodDb || []).map((food, index) => [
      encodeURIComponent(food.id || `food_${index}`), {
        name: String(food.name || ''), portionDesc: String(food.portionDesc || ''),
        portionG: Number(food.portionG) || 0, portionUnit: food.portionUnit || 'g',
        kcalPer100: Number(food.kcalPer100) || 0,
        proteinPer100: Number(food.proteinPer100) || 0,
        fatPer100: Number(food.fatPer100) || 0,
        carbsPer100: Number(food.carbsPer100) || 0,
        fiberPer100: Number(food.fiberPer100) || 0,
        ...meta
      }
    ]));

    await replaceRemoteCollection('foodLogs', foodLogs);
    await replaceRemoteCollection('waterLogs', waterLogs);
    await replaceRemoteCollection('bodyRecords', bodyRecords);
    await replaceRemoteCollection('foods', foods);
  } catch(e) {
    console.warn('Cloud save failed:', e);
    toast('云同步失败，请稍后重试', 'error');
  } finally {
    isSyncing = false;
    setSyncingUI(false);
  }
}

// Debounced cloud save
function debouncedCloudSave() {
  if (!db || !currentUser) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => saveToCloud(), 2000);
}

async function readRemoteCollection(name) {
  const snapshot = await db.collection('users').doc(currentUser.uid).collection(name).get();
  return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
}

// Load normalized state. The newer side wins as a complete document set;
// individual dates/records remain independent Firestore documents.
async function loadFromCloud() {
  if (!db || !currentUser) return;
  try {
    setSyncingUI(true);
    const userRef = db.collection('users').doc(currentUser.uid);
    const [profileDoc, settingsDoc, foodDocs, waterDocs, bodyDocs, foodDbDocs] = await Promise.all([
      userRef.collection('profile').doc('current').get(),
      userRef.collection('settings').doc('current').get(),
      readRemoteCollection('foodLogs'), readRemoteCollection('waterLogs'),
      readRemoteCollection('bodyRecords'), readRemoteCollection('foods')
    ]);
    const allRemote = [
      ...(profileDoc.exists ? [{ data: profileDoc.data() }] : []),
      ...(settingsDoc.exists ? [{ data: settingsDoc.data() }] : []),
      ...foodDocs, ...waterDocs, ...bodyDocs, ...foodDbDocs
    ];
    if (allRemote.length === 0) {
      // One-time migration from the legacy single-document format.
      const legacy = await userRef.get();
      if (legacy.exists && legacy.data().appState) {
        state = migrateState(JSON.parse(legacy.data().appState));
        state.todayLog = state.historyLogs[viewingDate] || [];
        await saveToCloud();
        await userRef.delete();
      } else {
        await saveToCloud();
      }
      return;
    }

    const remoteLastModified = Math.max(...allRemote.map(item => remoteTimestamp(item.data)), 0);
    const localLastModified = Number(state._lastModified) || 0;
    if (remoteLastModified > localLastModified) {
      const remote = createDefaultState();
      if (profileDoc.exists) {
        const p = profileDoc.data();
        remote.profile = { gender:p.gender, age:p.age, height:p.height, weight:p.weight, goal:p.goal, activity:p.activity };
        remote.bmr = p.bmr || 0; remote.tdee = p.tdee || 0; remote.targetKcal = p.targetKcal || 0;
      }
      if (settingsDoc.exists) {
        const s = settingsDoc.data();
        remote.waterGoal = s.waterGoal ?? null;
        remote.apiConfig = s.apiProvider ? { provider:s.apiProvider, model:s.apiModel || '', url:API_ENDPOINTS[s.apiProvider] || '' } : null;
        remote.historyRange = s.historyRange || 30;
        remote.bodyChartRange = s.bodyChartRange || 30;
        remote.fitnessGoal = s.fitnessGoal || null;
      }
      remote.historyLogs = Object.fromEntries(foodDocs.map(doc => [doc.id, doc.data.entries || []]));
      remote.waterLogs = Object.fromEntries(waterDocs.map(doc => [doc.id, { total:doc.data.total || 0, records:doc.data.records || [] }]));
      remote.bodyRecords = bodyDocs.map(doc => ({ id:decodeURIComponent(doc.id), ...doc.data, updatedAt:undefined, clientUpdatedAt:undefined, schemaVersion:undefined }));
      remote.foodDb = foodDbDocs.map(doc => ({ id:decodeURIComponent(doc.id), ...doc.data, updatedAt:undefined, clientUpdatedAt:undefined, schemaVersion:undefined }));
      remote._lastModified = remoteLastModified;
      state = migrateState(remote);
      state.todayLog = state.historyLogs[viewingDate] || [];
      localStorage.setItem('nutriai_state', JSON.stringify(sanitizePersistedState(state)));
      toast('☁️ 已从云端同步最新数据', 'success');
      updateDashboard(); renderHistoryChart(); renderHistoryList(); loadBodyPageState();
      if (state.profile && state.bmr) showTdeeResult();
    } else if (localLastModified > remoteLastModified) {
      await saveToCloud();
    }
  } catch(e) {
    console.warn('Cloud load failed:', e);
    toast('云端数据加载失败，当前继续使用本地数据', 'error');
  } finally {
    setSyncingUI(false);
  }
}

// ============================================================
//  STATE
// ============================================================
let state = createDefaultState();

let viewingDate = null; // currently viewing date (YYYY-MM-DD)
let calYear, calMonth;  // calendar display state

let pieChartInst = null;
let historyChartInst = null;
let bodyChartInst = null;
let toastTimer;
const THEME_KEY = 'nutriai_theme';

function applyTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected === 'light' ? '#f5f7fb' : '#0f1117');
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.textContent = selected === 'light' ? '🌙 深色模式' : '☀️ 浅色模式';
    button.setAttribute('aria-pressed', String(selected === 'light'));
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// ============================================================
//  INIT
// ============================================================
function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  loadFromStorage();
  // Initialize viewing date to today
  viewingDate = getToday();
  // Initialize Firebase cloud sync
  initFirebase();
  const today = getToday();
  if (state.historyLogs[today]) {
    state.todayLog = state.historyLogs[today];
  }
  updateDate();
  setInterval(updateDate, 60000);
  updateDashboard();
  updateApiPlaceholder();
  renderHistoryChart();
  renderHistoryList();
  loadBodyPageState();
  // Show API banner if not configured
  checkApiBanner();
}

function loadFromStorage() {
  try {
    const s = localStorage.getItem('nutriai_state');
    if (s) {
      const parsed = JSON.parse(s);
      // One-time migration from older versions that persisted credentials.
      if (parsed.apiConfig && parsed.apiConfig.key) setSecret('ai', parsed.apiConfig.key);
      if (parsed.usda_key) setSecret('usda', parsed.usda_key);
      const sanitized = sanitizePersistedState(parsed);
      localStorage.setItem('nutriai_state', JSON.stringify(sanitized));
      state = migrateState(sanitized);
    }
    // Apply saved profile to form
    if (state.profile) {
      const p = state.profile;
      document.getElementById('p-gender').value = p.gender || 'male';
      document.getElementById('p-age').value = p.age || '';
      document.getElementById('p-height').value = p.height || '';
      document.getElementById('p-weight').value = p.weight || '';
      document.getElementById('p-activity').value = p.activity || '1.55';
      document.getElementById('p-goal').value = p.goal || 'maintain';
    }
    if (state.apiConfig) {
      const a = state.apiConfig;
      const provider = API_ENDPOINTS[a.provider] ? a.provider : 'deepseek';
      document.getElementById('api-provider').value = provider;
      document.getElementById('api-key').value = getSecret('ai');
      document.getElementById('api-model').value = a.model || '';
      // Update hints/placeholder (won't override model since we already set it)
      const hint = document.getElementById('model-hint');
      if (hint && MODEL_HINTS[a.provider]) hint.textContent = `（可选：${MODEL_HINTS[a.provider]}）`;
      // Restore saved model (override any auto-fill)
      if (a.model) document.getElementById('api-model').value = a.model;
    }
    if (state.profile && state.bmr) {
      showTdeeResult();
    }
    document.getElementById('usda-key').value = getSecret('usda');
  } catch(e) {
    console.warn('Local data load failed:', e?.message || 'unknown error');
    toast('本地数据读取失败，已使用安全默认值', 'error');
  }
}

function saveToStorage() {
  try {
    // Save current viewing date's log into historyLogs
    const d = viewingDate || getToday();
    if (state.todayLog.length > 0) {
      state.historyLogs[d] = state.todayLog;
    } else if (state.historyLogs[d]) {
      delete state.historyLogs[d]; // clean up empty logs
    }
    state._lastModified = Date.now();
    localStorage.setItem('nutriai_state', JSON.stringify(sanitizePersistedState(state)));
    // Sync to cloud if logged in
    debouncedCloudSave();
  } catch(e) {
    console.warn('Local data save failed:', e?.message || 'unknown error');
    toast('本地保存失败，请检查浏览器存储空间', 'error');
  }
}

function getToday() {
  return localDateKey();
}

function updateDate() {
  const vd = viewingDate || getToday();
  const d = new Date(vd + 'T00:00:00');
  const month = d.getMonth()+1;
  const day = d.getDate();
  const weekdays = ['日','一','二','三','四','五','六'];
  document.getElementById('sidebarDate').textContent = `${month}月${day}日 周${weekdays[d.getDay()]}`;
  const label = document.getElementById('sidebar-date-label');
  if (vd === getToday()) {
    label.textContent = '📍 今天（点击切换）';
  } else {
    label.textContent = '📅 查看历史（点击切换）';
  }
}

// ============================================================
//  DATE CALENDAR
// ============================================================
let calOpen = false;

function toggleDateCalendar() {
  const el = document.getElementById('date-calendar');
  calOpen = !calOpen;
  if (calOpen) {
    const d = viewingDate || getToday();
    calYear = parseInt(d.slice(0,4));
    calMonth = parseInt(d.slice(5,7));
    renderCalendar();
    el.style.display = '';
    // Auto-close when clicking outside
    setTimeout(() => document.addEventListener('click', closeCalOnOutside), 10);
  } else {
    el.style.display = 'none';
    document.removeEventListener('click', closeCalOnOutside);
  }
}

function closeCalOnOutside(e) {
  const cal = document.getElementById('date-calendar');
  const badge = cal?.parentElement;
  if (calOpen && !cal.contains(e.target) && !badge.contains(e.target)) {
    toggleDateCalendar();
  }
}

function changeCalMonth(delta) {
  calMonth += delta;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  if (calMonth < 1) { calMonth = 12; calYear--; }
  renderCalendar();
}

function renderCalendar() {
  const today = getToday();
  const sel = viewingDate || today;
  document.getElementById('cal-title').textContent = `${calYear}年${calMonth}月`;

  const firstDay = new Date(calYear, calMonth - 1, 1);
  let startWeekday = firstDay.getDay(); // 0=Sun
  if (startWeekday === 0) startWeekday = 7; // shift to Mon-based: 1=Mon..7=Sun
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth - 1, 0).getDate();

  let html = '';

  // Previous month's trailing days
  for (let i = startWeekday - 2; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    const pm = calMonth - 1 === 0 ? 12 : calMonth - 1;
    const py = calMonth - 1 === 0 ? calYear - 1 : calYear;
    const dateStr = `${py}-${String(pm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const hasData = state.historyLogs[dateStr] && state.historyLogs[dateStr].length > 0;
    html += `<button class="cal-day other-month${hasData?' has-data':''}" data-action="selectDate('${dateStr}')">${day}</button>`;
  }

  // Current month
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = dateStr === today;
    const isSel = dateStr === sel;
    const hasData = state.historyLogs[dateStr] && state.historyLogs[dateStr].length > 0;
    let cls = 'cal-day';
    if (isToday) cls += ' today';
    if (isSel) cls += ' selected';
    if (hasData) cls += ' has-data';
    html += `<button class="${cls}" data-action="selectDate('${dateStr}')">${day}</button>`;
  }

  // Next month's leading days
  const totalCells = startWeekday - 1 + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let day = 1; day <= remaining; day++) {
    const nm = calMonth + 1 === 13 ? 1 : calMonth + 1;
    const ny = calMonth + 1 === 13 ? calYear + 1 : calYear;
    const dateStr = `${ny}-${String(nm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const hasData = state.historyLogs[dateStr] && state.historyLogs[dateStr].length > 0;
    html += `<button class="cal-day other-month${hasData?' has-data':''}" data-action="selectDate('${dateStr}')">${day}</button>`;
  }

  document.getElementById('cal-days').innerHTML = html;
}

function selectDate(dateStr) {
  // Save current todayLog back before switching
  const prevDate = viewingDate || getToday();
  if (state.todayLog.length > 0) {
    state.historyLogs[prevDate] = state.todayLog;
  }

  // Switch to new date
  viewingDate = dateStr;
  state.todayLog = state.historyLogs[dateStr] ? JSON.parse(JSON.stringify(state.historyLogs[dateStr])) : [];
  saveToStorage();

  // Update UI
  updateDate();
  updateDashboard();
  renderTodayMeals();
  renderCalendar();

  // Close calendar after a brief delay
  setTimeout(() => {
    if (calOpen) toggleDateCalendar();
  }, 200);

  // Refresh history page if visible
  renderHistoryChart();
  renderHistoryList();
}

function goToToday() {
  const today = getToday();
  selectDate(today);
  // Also reset calendar to current month
  calYear = parseInt(today.slice(0,4));
  calMonth = parseInt(today.slice(5,7));
}

function shiftDate(delta) {
  const d = new Date((viewingDate || getToday()) + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  // Format as YYYY-MM-DD
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  selectDate(`${y}-${m}-${day}`);
}

function checkApiBanner() {
  const banner = document.getElementById('api-banner');
  if (!state.apiConfig || !getSecret('ai')) {
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

// ============================================================
//  NAVIGATION
// ============================================================
function goPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  const btns = document.querySelectorAll('.nav-item');
  btns.forEach(b => {
    if (b.textContent.includes(pageLabel(name))) b.classList.add('active');
  });
  if (name === 'dashboard') updateDashboard();
  if (name === 'history') { renderHistoryChart(); renderHistoryList(); }
  if (name === 'analysis') updateAnalysisSummary();
  if (name === 'body') { renderBodyPage(); }
  if (name === 'fooddb') { renderFoodDb(); }
}

function pageLabel(n) {
  const m = {dashboard:'概览', record:'饮食', analysis:'分析', history:'历史', body:'身体', profile:'设置', fooddb:'食物库'};
  return m[n]||'';
}

// ============================================================
//  PROFILE & TDEE (Mifflin-St Jeor)
// ============================================================
function calcBMR(gender, weight, height, age) {
  // Mifflin-St Jeor Equation
  // Men:   BMR = 10W + 6.25H - 5A + 5
  // Women: BMR = 10W + 6.25H - 5A - 161
  if (gender === 'male') {
    return 10 * weight + 6.25 * height - 5 * age + 5;
  } else {
    return 10 * weight + 6.25 * height - 5 * age - 161;
  }
}

function saveProfile() {
  const gender = document.getElementById('p-gender').value;
  const age    = boundedNumber(document.getElementById('p-age').value, 10, 120);
  const height = boundedNumber(document.getElementById('p-height').value, 100, 250);
  const weight = boundedNumber(document.getElementById('p-weight').value, 30, 500);
  const activity = parseFloat(document.getElementById('p-activity').value);
  const goal   = document.getElementById('p-goal').value;

  if (age === null || height === null || weight === null) {
    toast('年龄需为10-120岁、身高100-250cm、体重30-500kg', 'error'); return;
  }

  const bmr  = Math.round(calcBMR(gender, weight, height, age));
  const tdee = Math.round(bmr * activity);
  let targetKcal;
  if (goal === 'lose')     targetKcal = tdee - 500;
  else if (goal === 'gain') targetKcal = tdee + 300;
  else                      targetKcal = tdee;

  state.profile = { gender, age, height, weight, activity, goal };
  state.bmr = bmr;
  state.tdee = tdee;
  state.targetKcal = targetKcal;
  setSecret('usda', document.getElementById('usda-key').value.trim());
  saveToStorage();
  showTdeeResult();
  updateDashboard();
  updateAnalysisSummary();
  toast('个人信息已保存，TDEE 计算完成 ✅', 'success');
}

function showTdeeResult() {
  if (!state.bmr) return;
  document.getElementById('tdee-result').style.display = '';
  document.getElementById('res-bmr').textContent = state.bmr;
  document.getElementById('res-tdee').textContent = state.tdee;
  document.getElementById('res-target').textContent = state.targetKcal;

  const goalText = {lose:'减脂（TDEE - 500 kcal）', maintain:'维持体重（等于 TDEE）', gain:'增肌（TDEE + 300 kcal）'};
  const p = state.profile;
  document.getElementById('tdee-explain').innerHTML = `
    <strong>计算公式：</strong>Mifflin-St Jeor Equation<br>
    BMR = 10 × ${p.weight} + 6.25 × ${p.height} - 5 × ${p.age} ${p.gender==='male'?'+ 5':'- 161'} = <strong>${state.bmr} kcal</strong><br>
    TDEE = BMR × 活动系数（${p.activity}）= <strong>${state.tdee} kcal</strong><br>
    目标：${goalText[p.goal]} → 推荐摄入 <strong style="color:var(--green)">${state.targetKcal} kcal</strong>
  `;
}

// ============================================================
//  API CONFIG
// ============================================================

function updateApiPlaceholder() {
  const provider = document.getElementById('api-provider').value;
  const modelInput = document.getElementById('api-model');
  const hint = document.getElementById('model-hint');

  modelInput.placeholder = DEFAULT_MODELS[provider] || 'model-name';
  hint.textContent = MODEL_HINTS[provider] ? `（可选：${MODEL_HINTS[provider]}）` : '';
  if (!modelInput.value.trim()) {
    modelInput.value = DEFAULT_MODELS[provider] || '';
  }
}

function saveApiConfig() {
  const statusEl = document.getElementById('save-status');
  try {
    statusEl.textContent = '⏳ 保存中...';
    statusEl.style.color = 'var(--text2)';
    const provider = document.getElementById('api-provider').value;
    const key   = document.getElementById('api-key').value.trim();
    const model = document.getElementById('api-model').value.trim() || DEFAULT_MODELS[provider];

    if (!key) { statusEl.textContent = '❌ 请填写 API Key'; statusEl.style.color = 'var(--red)'; toast('请填写 API Key', 'error'); return; }
    if (!model) { statusEl.textContent = '❌ 请填写模型名称'; statusEl.style.color = 'var(--red)'; toast('请填写模型名称', 'error'); return; }

    // Auto-fix common model name mistakes
    let fixedModel = model;
    if (provider === 'minimax') {
      // MiniMax uses hyphen format: "MiniMax-M2.7", not "MiniMax M2.7" or "minimax m2.7"
      if (/minimax\s+m/i.test(fixedModel)) fixedModel = fixedModel.replace(/\s+(m\d)/i, '-$1');
      if (!fixedModel.startsWith('MiniMax')) fixedModel = fixedModel.charAt(0).toUpperCase() + fixedModel.slice(1);
    }
    if (fixedModel !== model) {
      document.getElementById('api-model').value = fixedModel;
      toast(`ℹ️ 模型名已自动修正：${model} → ${fixedModel}`, '');
    }

    const finalUrl = API_ENDPOINTS[provider];
    state.apiConfig = { provider, model: fixedModel, url: finalUrl };
    setSecret('ai', key);
    setSecret('usda', document.getElementById('usda-key').value.trim());
    saveToStorage();
    checkApiBanner();
    statusEl.textContent = `✅ 已保存：${provider} | 模型：${fixedModel}`;
    statusEl.style.color = 'var(--green)';
    toast(`✅ API 配置已保存（${provider}）`, 'success');
  } catch(e) {
    statusEl.textContent = '❌ 保存失败：' + e.message;
    statusEl.style.color = 'var(--red)';
    toast('❌ 保存失败：' + e.message, 'error');
    console.error('saveApiConfig error:', e);
  }
}

function saveUsdaKey() {
  const key = document.getElementById('usda-key').value.trim();
  setSecret('usda', key);
  toast(key ? '✅ USDA API Key 已保存到当前会话' : '✅ 已清空 USDA Key（将使用内置估算）', 'success');
}

async function resetAllData() {
  if (!confirm('确定要清除这台设备上的全部数据吗？\n云端数据不会删除；如已登录，本操作会同时退出登录。')) return;
  if (currentUser) await firebase.auth().signOut().catch(() => {});
  localStorage.removeItem('nutriai_state');
  sessionStorage.removeItem(SECRET_KEYS.ai);
  sessionStorage.removeItem(SECRET_KEYS.usda);
  location.reload();
}

function setDataActionStatus(message, isError = false) {
  const element = document.getElementById('data-action-status');
  if (!element) return;
  element.textContent = message;
  element.style.color = isError ? 'var(--red)' : 'var(--text2)';
}

function exportData() {
  const payload = {
    format: 'nutriai-export',
    schemaVersion: DATA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: sanitizePersistedState(state)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nutriai-backup-${getToday()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setDataActionStatus('✅ 数据已导出；文件不包含任何 API Key。');
}

function openImportPicker() {
  const input = document.getElementById('data-import-file');
  input.value = '';
  input.click();
}

async function importData(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setDataActionStatus('导入失败：文件不能超过 5 MB。', true); return;
  }
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'nutriai-export' || !parsed.data || typeof parsed.data !== 'object') {
      throw new Error('不是有效的 NutriAI 导出文件');
    }
    const imported = migrateState(parsed.data);
    if (!confirm('导入会替换当前设备的数据。是否继续？')) return;
    state = imported;
    state._lastModified = Date.now();
    state.todayLog = state.historyLogs[getToday()] || [];
    localStorage.setItem('nutriai_state', JSON.stringify(sanitizePersistedState(state)));
    if (currentUser) await saveToCloud();
    setDataActionStatus('✅ 数据导入成功，正在刷新页面。');
    location.reload();
  } catch (error) {
    setDataActionStatus('导入失败：' + error.message, true);
  }
}

async function deleteRemoteCollection(name) {
  const collection = db.collection('users').doc(currentUser.uid).collection(name);
  while (true) {
    const snapshot = await collection.limit(400).get();
    if (snapshot.empty) break;
    const batch = db.batch();
    snapshot.forEach(document => batch.delete(document.ref));
    await batch.commit();
    if (snapshot.size < 400) break;
  }
}

async function deleteAllCloudData() {
  if (!db || !currentUser) throw new Error('请先登录');
  for (const name of ['profile', 'settings', 'foodLogs', 'waterLogs', 'bodyRecords', 'foods']) {
    await deleteRemoteCollection(name);
  }
  await db.collection('users').doc(currentUser.uid).delete().catch(() => {});
}

async function deleteCloudData() {
  if (!currentUser) { setDataActionStatus('请先登录后再删除云端数据。', true); return; }
  if (!confirm('确定永久删除当前账号的全部云端营养数据吗？\n本机数据和账号会保留。此操作不可撤销。')) return;
  try {
    setDataActionStatus('正在删除云端数据...');
    await deleteAllCloudData();
    setDataActionStatus('✅ 云端数据已全部删除，本机数据仍然保留。');
  } catch (error) {
    setDataActionStatus('删除失败：' + error.message, true);
  }
}

async function deleteAccountAndData() {
  if (!currentUser) { setDataActionStatus('请先登录。', true); return; }
  if (!confirm('确定删除账号、云端数据和本机数据吗？\n此操作不可撤销。')) return;
  try {
    setDataActionStatus('正在删除账号及全部数据...');
    await deleteAllCloudData();
    await currentUser.delete();
    localStorage.removeItem('nutriai_state');
    sessionStorage.removeItem(SECRET_KEYS.ai);
    sessionStorage.removeItem(SECRET_KEYS.usda);
    location.reload();
  } catch (error) {
    const message = error.code === 'auth/requires-recent-login'
      ? '为保护账号安全，请退出后重新登录，再执行删除账号。'
      : error.message;
    setDataActionStatus('删除失败：' + message, true);
  }
}

async function testApiConfig() {
  if (!state.apiConfig || !getSecret('ai')) {
    toast('请先填写并保存 API Key', 'error'); return;
  }
  const btn = document.getElementById('api-test-btn');
  const originalText = btn?.textContent;
  if (btn) btn.textContent = '⏳ 连接中（最长30秒）...';
  toast('🔌 正在测试连接，请稍候...', '');
  try {
    const res = await callLLM('你好', '请只回复"连接成功"这四个字，不要有其他内容。');
    toast('✅ 连接成功：' + (res || '(空响应)').slice(0, 40), 'success');
  } catch(e) {
    let msg = e.message;
    const isCors = e.message.includes('Failed to fetch') || e.message.includes('NetworkError') || e.message.includes('CORS') || e.message.includes('Load failed');
    if (e.name === 'AbortError') {
      msg = '请求超时（30秒），请检查网络或 API 地址是否正确';
    } else if (isCors) {
      msg = '网络错误或服务商不允许浏览器跨域请求。为保护 API Key，本应用不会使用公共代理；请改用支持浏览器直连的服务商，或部署自己的受信任后端。';
    } else if (e.message.includes('401')) {
      msg = 'API Key 无效或已过期（401），请检查 Key 是否正确';
    } else if (e.message.includes('404')) {
      msg = 'API 地址不存在（404），请检查端点 URL 是否正确';
    } else if (e.message.includes('400')) {
      msg = '请求参数错误（400），通常是模型名称不正确。MiniMax 模型名请使用连字符格式，如 MiniMax-M2.7（不是空格）';
    } else if (e.message.includes('429')) {
      msg = '请求频率超限（429），请稍后再试';
    }
    toast('❌ ' + msg, 'error');
  } finally {
    if (btn && originalText) btn.textContent = originalText;
  }
}

// ============================================================
//  LLM CALL
// ============================================================
async function callLLM(userMsg, systemMsg) {
  const cfg = state.apiConfig;
  const apiKey = getSecret('ai');
  if (!cfg || !apiKey) throw new Error('请先在个人设置中配置 API Key');
  const endpoint = cfg.url || API_ENDPOINTS[cfg.provider];
  if (!endpoint) throw new Error('API 地址未配置，请检查设置');
  const model = cfg.model || DEFAULT_MODELS[cfg.provider];
  if (!model) throw new Error('模型名称未配置，请检查设置');

  const reqBody = {
    model,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user',   content: userMsg }
    ],
    temperature: 0.3,
    max_tokens: 2000,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(reqBody),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    let errText = '';
    try { errText = await resp.text(); } catch(_) { errText = '无法读取服务端错误详情'; }
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0,300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function sendFoodMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  if (!state.apiConfig || !getSecret('ai')) {
    appendMessage('ai', '⚠️ 请先在「个人设置」中配置 API Key，才能使用 AI 解析功能。');
    goPage('profile');
    return;
  }

  appendMessage('user', text);
  input.value = '';

  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;
  document.getElementById('send-icon').innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>';

  // Show loading in parsed result
  document.getElementById('parsed-result').innerHTML = `
    <div style="text-align:center;padding:32px;">
      <div class="loading"><div class="dot"></div><div class="dot"></div><div class="dot"></div><span>AI 正在解析食物营养...</span></div>
    </div>`;
  document.getElementById('add-to-log-btn').style.display = 'none';

  try {
    // 动态构建包含食物库的 system prompt
    let dynamicSystem = PARSE_SYSTEM;
    if (state.foodDb && state.foodDb.length > 0) {
      const dbLines = state.foodDb.map(f => {
        const unit = f.portionUnit || 'g';
        const portionInfo = f.portionG > 0
          ? `，每份（${f.portionDesc || '1份'}）= ${f.portionG}${unit}，【重要：weight_g 必须填「用户说的数量 × ${f.portionG}」，例如2份就填${f.portionG * 2}，3份就填${f.portionG * 3}】`
          : '';
        return `- ${f.name}：每100${unit}含热量${f.kcalPer100}kcal、蛋白质${f.proteinPer100}g、脂肪${f.fatPer100}g、碳水${f.carbsPer100}g、纤维${f.fiberPer100}g${portionInfo}`;
      }).join('\n');
      dynamicSystem += `\n\n【用户自定义食物库 - 强制规则】
以下是用户预设的食物数据，遇到匹配项时：
1. 必须使用下方提供的每100g营养数据（不得使用通用数据库）
2. 若用户说了数量（如"2包""3个""半份"），weight_g = 数量 × 每份克数（已在各条目末尾标注）
3. 若未说数量，weight_g = 1 × 每份克数（即默认1份）
4. kcal/protein_g/fat_g/carbs_g/fiber_g 均按 weight_g/100 × 每100g数值计算
5. note 字段注明「来自食物库，X份×每份Yg=Zg」

食物库数据：
${dbLines}`;
    }
    const raw = await callLLM(text, dynamicSystem);
    // Extract JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式错误，请重试');
    const parsed = validateNutritionResponse(JSON.parse(jsonMatch[0]));

    // ---- 自定义食物库优先匹配（双保险校验）----
    // 预处理：从用户原始输入中提取所有"数量+量词"的位置列表
    const cnNumMap = {'一':1,'两':2,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'半':0.5};
    // 匹配所有数量词：如 "2包" "3个" "两瓶" "半份" 等，记录其在输入中的位置和数值
    const qtyPattern = /([\d.]+|[一两二三四五六七八九十半])\s*[个包袋盒杯碗片块条根颗粒份瓶罐]/g;
    const allQtyMatches = [];
    let qm;
    while ((qm = qtyPattern.exec(text)) !== null) {
      const raw = qm[1];
      const val = /[\d.]/.test(raw) ? parseFloat(raw) : (cnNumMap[raw] || null);
      if (val !== null) {
        allQtyMatches.push({ index: qm.index, end: qm.index + qm[0].length, qty: val, text: qm[0] });
      }
    }

    // 根据食物库条目名称，在原始输入中找到该食物出现的位置，然后找最近的数量词
    function findQtyForFood(inputText, foodLibName, aiFoodName) {
      // 用食物库名字的关键词（去空格后的最后几个中文字）在输入中定位
      const candidates = [foodLibName, aiFoodName].filter(Boolean);
      let bestPos = -1;
      for (const name of candidates) {
        // 尝试用名字的不同子串去定位（取末尾4字、末尾3字，增加命中率）
        const stripped = name.replace(/\s/g, '');
        const tries = [
          stripped,
          stripped.slice(-4),
          stripped.slice(-3),
          stripped.slice(-5),
        ].filter(s => s.length >= 2);
        for (const sub of tries) {
          const idx = inputText.indexOf(sub);
          if (idx !== -1) { bestPos = idx; break; }
        }
        if (bestPos !== -1) break;
      }
      if (bestPos === -1 || allQtyMatches.length === 0) return null;
      // 找距离 bestPos 最近的数量词（前后各20字内）
      let nearest = null, minDist = Infinity;
      for (const q of allQtyMatches) {
        const dist = Math.min(Math.abs(q.index - bestPos), Math.abs(q.end - bestPos));
        if (dist < minDist && dist <= 20) { minDist = dist; nearest = q; }
      }
      return nearest ? nearest.qty : null;
    }

    let dbHits = 0;
    parsed.foods = parsed.foods.map(f => {
      const match = matchFoodDb(f.name);
      if (!match) return f;
      dbHits++;
      const matchUnit = match.portionUnit || 'g';
      const singlePortionG = match.portionG > 0 ? match.portionG : 100;

      // 双保险：从原始输入提取该食物对应的数量
      const qty = findQtyForFood(text, match.name, f.name);
      // AI 给的重量（有时 AI 已正确计算了，有时没有）
      let weight = (f.weight_g > 0) ? f.weight_g : singlePortionG;
      // 如果提取到有效数量，且 AI 返回重量 ≈ 单份重量（说明 AI 没乘数量），则强制修正
      if (qty && qty > 0 && match.portionG > 0) {
        const aiOnlySinglePortion = Math.abs(weight - singlePortionG) / singlePortionG < 0.15;
        if (aiOnlySinglePortion && Math.abs(qty - 1) > 0.01) {
          weight = qty * singlePortionG;
        }
      }

      const ratio = weight / 100;
      const qtyStr = qty && match.portionG > 0
        ? `${qty}份×每份${singlePortionG}${matchUnit}=${weight}${matchUnit}`
        : `${weight}${matchUnit}`;
      return {
        name: match.name,
        name_en: f.name_en || '',
        weight_g: weight,
        kcal: parseFloat((match.kcalPer100 * ratio).toFixed(1)),
        protein_g: parseFloat((match.proteinPer100 * ratio).toFixed(1)),
        fat_g: parseFloat((match.fatPer100 * ratio).toFixed(1)),
        carbs_g: parseFloat((match.carbsPer100 * ratio).toFixed(1)),
        fiber_g: parseFloat((match.fiberPer100 * ratio).toFixed(1)),
        note: `来自食物库，${qtyStr}`,
        _fromDb: true
      };
    });
    // 重新计算 total
    parsed.total = parsed.foods.reduce((acc, f) => {
      acc.kcal += f.kcal; acc.protein_g += f.protein_g;
      acc.fat_g += f.fat_g; acc.carbs_g += f.carbs_g; acc.fiber_g += f.fiber_g;
      return acc;
    }, { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, fiber_g: 0 });
    ['kcal','protein_g','fat_g','carbs_g','fiber_g'].forEach(k => {
      parsed.total[k] = parseFloat(parsed.total[k].toFixed(1));
    });
    // ---- 匹配结束 ----

    state.pendingFoods = { meal: state.currentMeal, foods: parsed.foods, total: parsed.total };
    renderParsedResult(parsed);
    const dbNote = dbHits > 0 ? `（其中 ${dbHits} 种来自你的食物库 🗂️）` : '';
    appendMessage('ai', `✅ 已解析 ${parsed.foods.length} 种食物，合计约 ${Math.round(parsed.total.kcal)} kcal${dbNote}。确认无误后点击「添加到今日记录」。`);
  } catch(e) {
    appendMessage('ai', '❌ 解析失败：' + e.message + '。请检查 API 配置或重新描述食物。');
    document.getElementById('parsed-result').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
  } finally {
    sendBtn.disabled = false;
    document.getElementById('send-icon').textContent = '发送';
  }
}

function appendMessage(role, message) {
  const container = document.getElementById('chat-messages');
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = String(message ?? '');
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = timeStr;
  div.append(bubble, time);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderParsedResult(data) {
  let html = '';
  data.foods.forEach(f => {
    html += `
    <div class="food-item" style="flex-direction:column;align-items:flex-start;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:flex-start;">
        <div>
          <div class="food-name">${escapeHtml(f.name)} <span style="font-size:12px;color:var(--text3)">${escapeHtml(f.name_en||'')}</span>${f._fromDb ? ' <span style="font-size:11px;background:rgba(108,99,255,.15);color:var(--primary-light);padding:1px 6px;border-radius:10px;">🗂️ 食物库</span>' : ''}</div>
          <div class="food-meta">重量：${f.weight_g}g ${f.note?'· '+escapeHtml(f.note):''}</div>
        </div>
        <div style="text-align:right;">
          <div class="food-kcal">${Math.round(f.kcal)}<span class="food-kcal-unit"> kcal</span></div>
        </div>
      </div>
      <div class="food-nutrients">
        <div class="food-nutrient">蛋白 <span>${f.protein_g}g</span></div>
        <div class="food-nutrient">脂肪 <span>${f.fat_g}g</span></div>
        <div class="food-nutrient">碳水 <span>${f.carbs_g}g</span></div>
        <div class="food-nutrient">纤维 <span>${f.fiber_g}g</span></div>
      </div>
    </div>`;
  });
  html += `
    <div style="background:var(--bg);border-radius:8px;padding:14px 16px;margin-top:8px;">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px;font-weight:600;">📊 合计</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;">
        <div><span style="font-size:20px;font-weight:800;color:var(--primary-light)">${Math.round(data.total.kcal)}</span><span style="font-size:12px;color:var(--text3)"> kcal</span></div>
        <div class="food-nutrient">蛋白 <span>${data.total.protein_g}g</span></div>
        <div class="food-nutrient">脂肪 <span>${data.total.fat_g}g</span></div>
        <div class="food-nutrient">碳水 <span>${data.total.carbs_g}g</span></div>
        <div class="food-nutrient">纤维 <span>${data.total.fiber_g}g</span></div>
      </div>
    </div>`;
  document.getElementById('parsed-result').innerHTML = html;
  document.getElementById('add-to-log-btn').style.display = '';
}

function addToLog() {
  if (!state.pendingFoods) return;
  state.todayLog.push({
    meal: state.pendingFoods.meal,
    foods: state.pendingFoods.foods,
    total: state.pendingFoods.total,
    time: new Date().toISOString(),
  });
  state.pendingFoods = null;
  document.getElementById('add-to-log-btn').style.display = 'none';
  document.getElementById('parsed-result').innerHTML = `<div class="empty-state"><div class="icon">✅</div><p>已添加到今日记录！</p></div>`;
  appendMessage('ai', '🎉 已成功添加到今日饮食日志！前往「今日概览」查看完整记录。');
  saveToStorage();
  updateDashboard();
  toast('✅ 饮食记录已添加', 'success');
}

function selectMeal(btn, meal) {
  document.querySelectorAll('.meal-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.currentMeal = meal;
}

function fillExample(el) {
  document.getElementById('chat-input').value = el.textContent;
  document.getElementById('chat-input').focus();
}

// ============================================================
//  DASHBOARD UPDATE
// ============================================================
function getTotals() {
  let kcal=0, protein=0, fat=0, carbs=0, fiber=0;
  state.todayLog.forEach(entry => {
    kcal    += entry.total.kcal    || 0;
    protein += entry.total.protein_g || 0;
    fat     += entry.total.fat_g   || 0;
    carbs   += entry.total.carbs_g || 0;
    fiber   += entry.total.fiber_g || 0;
  });
  return { kcal:Math.round(kcal), protein:+protein.toFixed(1), fat:+fat.toFixed(1), carbs:+carbs.toFixed(1), fiber:+fiber.toFixed(1) };
}

function getGoals() {
  if (!state.targetKcal) return null;
  const kcal = state.targetKcal;
  // Standard macro split: protein 25%, fat 25%, carbs 50%
  return {
    kcal,
    protein: Math.round(kcal * 0.25 / 4),
    fat:     Math.round(kcal * 0.25 / 9),
    carbs:   Math.round(kcal * 0.50 / 4),
    fiber:   25
  };
}

function updateDashboard() {
  const t = getTotals();
  const g = getGoals();

  // Dynamic title based on viewing date
  const vd = viewingDate || getToday();
  const today = getToday();
  const titleEl = document.getElementById('dashboard-title');
  const subEl = document.getElementById('dashboard-subtitle');
  if (vd === today) {
    titleEl.textContent = '📊 今日概览';
    subEl.textContent = '记录你的每日营养摄入，让健康有据可查';
  } else {
    const dd = new Date(vd + 'T00:00:00');
    const weekdays = ['日','一','二','三','四','五','六'];
    titleEl.textContent = `📊 ${dd.getMonth()+1}月${dd.getDate()}日 周${weekdays[dd.getDay()]} 概览`;
    subEl.textContent = '查看历史营养摄入记录';
  }

  // Stat cards
  document.getElementById('dash-kcal').textContent    = t.kcal;
  document.getElementById('dash-protein').textContent = t.protein;
  document.getElementById('dash-fat').textContent     = t.fat;
  document.getElementById('dash-carbs').textContent   = t.carbs;
  document.getElementById('dash-kcal-goal').textContent    = g ? g.kcal : '--';
  document.getElementById('dash-protein-goal').textContent = g ? g.protein : '--';
  document.getElementById('dash-fat-goal').textContent     = g ? g.fat : '--';
  document.getElementById('dash-carbs-goal').textContent   = g ? g.carbs : '--';

  // Progress
  function setProgress(id, valId, cur, goal, unit) {
    const pct = goal ? Math.min(100, Math.round(cur/goal*100)) : 0;
    document.getElementById(id).style.width = pct+'%';
    document.getElementById(valId).textContent = `${cur} / ${goal||'--'} ${unit}`;
    // Color by percentage
    const el = document.getElementById(id);
    if (pct > 110) el.style.background = 'var(--red)';
    else if (pct > 90) el.style.background = 'var(--green)';
    // else keep original
  }
  setProgress('p-kcal',    'p-kcal-val',    t.kcal,    g?.kcal,    'kcal');
  setProgress('p-protein', 'p-protein-val', t.protein, g?.protein, 'g');
  setProgress('p-fat',     'p-fat-val',     t.fat,     g?.fat,     'g');
  setProgress('p-carbs',   'p-carbs-val',   t.carbs,   g?.carbs,   'g');
  setProgress('p-fiber',   'p-fiber-val',   t.fiber,   25,         'g');

  // Pie chart
  renderPieChart(t);

  // Water tracker
  renderWater();

  // Meal list
  renderTodayMeals();

  // Analysis page energy cards
  updateAnalysisEnergy(t);
}

function renderPieChart(t) {
  const canvas = document.getElementById('pieChart');
  const total = t.protein*4 + t.fat*9 + t.carbs*4;
  const proteinPct = total ? Math.round(t.protein*4/total*100) : 0;
  const fatPct     = total ? Math.round(t.fat*9/total*100) : 0;
  const carbsPct   = total ? Math.round(t.carbs*4/total*100) : 0;

  document.getElementById('pie-protein-pct').textContent = proteinPct + '%';
  document.getElementById('pie-fat-pct').textContent     = fatPct + '%';
  document.getElementById('pie-carbs-pct').textContent   = carbsPct + '%';

  const data = total > 0 ? [t.protein*4, t.fat*9, t.carbs*4] : [1,1,1];

  if (pieChartInst) {
    pieChartInst.data.datasets[0].data = data;
    pieChartInst.update();
    return;
  }
  pieChartInst = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['蛋白质', '脂肪', '碳水'],
      datasets: [{
        data,
        backgroundColor: ['rgba(108,99,255,0.8)', 'rgba(250,204,21,0.8)', 'rgba(96,165,250,0.8)'],
        borderColor: ['var(--primary)', '#ca8a04', '#2563eb'],
        borderWidth: 2,
      }]
    },
    options: {
      cutout: '65%',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} kcal 当量` }
      }}
    }
  });
}

function renderTodayMeals() {
  const container = document.getElementById('today-meals');
  if (state.todayLog.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🌱</div><p>今天还没有饮食记录<br>去「记录饮食」开始记录吧！</p></div>`;
    return;
  }
  const mealLabels = { breakfast:'☀️ 早餐', lunch:'🌤️ 午餐', dinner:'🌙 晚餐', snack:'🍎 零食' };
  const mealBadge  = { breakfast:'badge-breakfast', lunch:'badge-lunch', dinner:'badge-dinner', snack:'badge-snack' };
  let html = '';
  state.todayLog.forEach((entry, idx) => {
    const t = entry.total;
    const mealName = mealLabels[entry.meal] || entry.meal;
    const badgeClass = mealBadge[entry.meal] || '';
    const timeStr = entry.time ? new Date(entry.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '';
    html += `
    <div class="food-item" style="flex-direction:column;align-items:flex-start;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge ${badgeClass}">${mealName}</span>
          <span style="font-size:12px;color:var(--text3)">${timeStr}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="food-kcal">${Math.round(t.kcal)}<span class="food-kcal-unit"> kcal</span></div>
          <button class="btn btn-ghost btn-sm" data-action="editLogEntry(${idx})" style="padding:4px 8px;color:var(--blue);font-size:13px;" title="编辑">✏️</button>
          <button class="btn btn-ghost btn-sm" data-action="deleteLogEntry(${idx})" style="padding:4px 8px;color:var(--red)" title="删除">🗑️</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:6px;">
        ${entry.foods.map(f=>`${escapeHtml(f.name)}(${f.weight_g}g)`).join(' · ')}
      </div>
      <div class="food-nutrients">
        <div class="food-nutrient">蛋白 <span>${(+t.protein_g||0).toFixed(1)}g</span></div>
        <div class="food-nutrient">脂肪 <span>${(+t.fat_g||0).toFixed(1)}g</span></div>
        <div class="food-nutrient">碳水 <span>${(+t.carbs_g||0).toFixed(1)}g</span></div>
        <div class="food-nutrient">纤维 <span>${(+t.fiber_g||0).toFixed(1)}g</span></div>
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

function deleteLogEntry(idx) {
  state.todayLog.splice(idx, 1);
  saveToStorage();
  updateDashboard();
  toast('已删除记录', '');
}

// ============================================================
//  FOOD MODAL (Edit / Manual Add)
// ============================================================
let modalState = { editIdx: -1, meal: 'breakfast', foods: [] };

function openFoodModal(editIdx) {
  modalState.editIdx = editIdx;
  const overlay = document.getElementById('food-modal-overlay');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  if (editIdx >= 0) {
    // Edit mode
    const entry = state.todayLog[editIdx];
    modalState.meal = entry.meal;
    modalState.foods = JSON.parse(JSON.stringify(entry.foods));
    document.getElementById('food-modal-title').textContent = '✏️ 编辑饮食记录';
    document.getElementById('modal-save-btn').textContent = '✅ 保存修改';
  } else {
    // Manual add mode
    modalState.meal = 'breakfast';
    modalState.foods = [{ name:'', weight_g:0, kcal:0, protein_g:0, fat_g:0, carbs_g:0, fiber_g:0 }];
    document.getElementById('food-modal-title').textContent = '✍️ 手动记录饮食';
    document.getElementById('modal-save-btn').textContent = '➕ 添加到记录';
  }

  renderModalMealSelector();
  renderModalFoodList();
  updateModalTotal();
}

function openManualAdd() {
  openFoodModal(-1);
}

function editLogEntry(idx) {
  openFoodModal(idx);
}

function closeFoodModal() {
  document.getElementById('food-modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function renderModalMealSelector() {
  const btns = document.querySelectorAll('#modal-meal-selector .meal-btn');
  btns.forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-meal') === modalState.meal);
  });
}

function selectModalMeal(btn, meal) {
  modalState.meal = meal;
  renderModalMealSelector();
}

function renderModalFoodList() {
  const container = document.getElementById('modal-food-list');
  if (modalState.foods.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px;font-size:13px;">暂无食物，请在下方添加</div>';
    return;
  }
  let html = '';
  modalState.foods.forEach((f, i) => {
    html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border-radius:10px;margin-bottom:6px;">
      <span style="flex:1;font-size:13px;"><strong>${escapeHtml(f.name||'未命名')}</strong> <span style="color:var(--text3);">${f.weight_g||0}g</span></span>
      <span style="font-size:12px;color:var(--orange);">${Math.round(f.kcal||0)} kcal</span>
      <button class="btn btn-ghost btn-sm" data-action="removeModalFood(${i})" style="padding:3px 7px;color:var(--red);font-size:12px;">✕</button>
    </div>`;
  });
  container.innerHTML = html;
}

function removeModalFood(idx) {
  modalState.foods.splice(idx, 1);
  renderModalFoodList();
  updateModalTotal();
}

function addModalFoodRow() {
  const name = document.getElementById('modal-food-name').value.trim();
  const weight = boundedNumber(document.getElementById('modal-food-weight').value || 0, 0, 10000);
  const kcal = boundedNumber(document.getElementById('modal-food-kcal').value || 0, 0, 20000);
  const protein = boundedNumber(document.getElementById('modal-food-protein').value || 0, 0, 2000);
  const fat = boundedNumber(document.getElementById('modal-food-fat').value || 0, 0, 2000);
  const carbs = boundedNumber(document.getElementById('modal-food-carbs').value || 0, 0, 5000);
  const fiber = boundedNumber(document.getElementById('modal-food-fiber').value || 0, 0, 1000);

  if (!name || name.length > 100) {
    toast('请输入不超过100字的食物名称', 'error');
    document.getElementById('modal-food-name').focus();
    return;
  }

  if ([weight, kcal, protein, fat, carbs, fiber].some(value => value === null)) {
    toast('营养数值超出允许范围', 'error'); return;
  }
  modalState.foods.push({ name, weight_g: weight, kcal, protein_g: protein, fat_g: fat, carbs_g: carbs, fiber_g: fiber });

  // Clear inputs
  document.getElementById('modal-food-name').value = '';
  document.getElementById('modal-food-weight').value = '';
  document.getElementById('modal-food-kcal').value = '';
  document.getElementById('modal-food-protein').value = '';
  document.getElementById('modal-food-fat').value = '';
  document.getElementById('modal-food-carbs').value = '';
  document.getElementById('modal-food-fiber').value = '';
  document.getElementById('modal-food-name').focus();

  renderModalFoodList();
  updateModalTotal();
}

function updateModalTotal() {
  const totals = modalState.foods.reduce((acc, f) => ({
    kcal: acc.kcal + (f.kcal||0),
    p: acc.p + (f.protein_g||0),
    f: acc.f + (f.fat_g||0),
    c: acc.c + (f.carbs_g||0),
    fb: acc.fb + (f.fiber_g||0),
  }), { kcal:0, p:0, f:0, c:0, fb:0 });

  document.getElementById('modal-total-kcal').textContent = Math.round(totals.kcal);
  document.getElementById('modal-total-p').textContent = totals.p.toFixed(1);
  document.getElementById('modal-total-f').textContent = totals.f.toFixed(1);
  document.getElementById('modal-total-c').textContent = totals.c.toFixed(1);
  document.getElementById('modal-total-fb').textContent = totals.fb.toFixed(1);
}

function saveFoodModal() {
  if (modalState.foods.length === 0) {
    toast('请至少添加一种食物', 'error');
    return;
  }
  // Filter out empty entries
  modalState.foods = modalState.foods.filter(f => f.name && f.name.trim());

  if (modalState.foods.length === 0) {
    toast('请至少添加一种有效食物', 'error');
    return;
  }

  // Calculate total
  const total = modalState.foods.reduce((acc, f) => ({
    kcal: acc.kcal + (f.kcal||0),
    protein_g: acc.protein_g + (f.protein_g||0),
    fat_g: acc.fat_g + (f.fat_g||0),
    carbs_g: acc.carbs_g + (f.carbs_g||0),
    fiber_g: acc.fiber_g + (f.fiber_g||0),
  }), { kcal:0, protein_g:0, fat_g:0, carbs_g:0, fiber_g:0 });

  const entry = {
    meal: modalState.meal,
    foods: modalState.foods,
    total,
    time: new Date().toISOString(),
  };

  if (modalState.editIdx >= 0) {
    // Keep original time if editing
    const original = state.todayLog[modalState.editIdx];
    entry.time = original ? original.time : entry.time;
    state.todayLog[modalState.editIdx] = entry;
    toast('✅ 饮食记录已更新', 'success');
  } else {
    state.todayLog.push(entry);
    toast('✅ 已手动添加饮食记录', 'success');
  }

  saveToStorage();
  updateDashboard();
  closeFoodModal();
}

// Allow Enter key to add food row in modal
document.addEventListener('keydown', function(e) {
  const overlay = document.getElementById('food-modal-overlay');
  if (overlay.style.display !== 'flex') return;
  if (e.key === 'Enter' && !e.shiftKey) {
    const active = document.activeElement;
    if (active && (active.id === 'modal-food-name' || active.id.startsWith('modal-food-'))) {
      e.preventDefault();
      addModalFoodRow();
    }
  }
  if (e.key === 'Escape') {
    closeFoodModal();
  }
});

// ============================================================
//  ANALYSIS
// ============================================================
function updateAnalysisSummary() {
  const t = getTotals();
  const g = getGoals();
  const container = document.getElementById('analysis-summary');

  if (state.todayLog.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>请先记录今日饮食</p></div>`;
    return;
  }

  const items = [
    { label: '🔥 热量', cur: t.kcal, goal: g?.kcal, unit: 'kcal' },
    { label: '💪 蛋白质', cur: t.protein, goal: g?.protein, unit: 'g' },
    { label: '🧈 脂肪', cur: t.fat, goal: g?.fat, unit: 'g' },
    { label: '🌾 碳水', cur: t.carbs, goal: g?.carbs, unit: 'g' },
    { label: '🌿 纤维', cur: t.fiber, goal: 25, unit: 'g' },
  ];

  let html = '';
  items.forEach(item => {
    const pct = item.goal ? Math.round(item.cur/item.goal*100) : null;
    let status = '';
    if (pct !== null) {
      if (pct < 60) status = '⬇️ 明显不足';
      else if (pct < 85) status = '↙️ 略显不足';
      else if (pct <= 115) status = '✅ 达标';
      else if (pct <= 140) status = '↗️ 略微超标';
      else status = '⬆️ 严重超标';
    }
    html += `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:14px;">${item.label}</span>
      <span style="font-size:14px;color:var(--text2)">
        <strong style="color:var(--text)">${item.cur}${item.unit}</strong> / ${item.goal||'--'}${item.unit}
        ${pct!==null ? `<span style="margin-left:8px;font-size:12px;">(${pct}%) ${status}</span>` : ''}
      </span>
    </div>`;
  });
  container.innerHTML = html;
}

function updateAnalysisEnergy(totals) {
  document.getElementById('bmr-val').textContent    = state.bmr || '--';
  document.getElementById('tdee-val').textContent   = state.tdee || '--';
  document.getElementById('target-val').textContent = state.targetKcal || '--';
  const remaining = state.targetKcal ? Math.max(0, state.targetKcal - (totals||getTotals()).kcal) : '--';
  document.getElementById('remaining-val').textContent = remaining;
}

const ANALYSIS_SYSTEM = `你是一位专业营养师 AI，基于用户今日饮食数据给出简洁实用的中文分析建议。
分析内容要求：
1. 指出3-5个营养素的摄入状况（够/不足/过量）
2. 针对明显问题给出具体、可行的饮食调整建议（指明具体食物）
3. 给出一句总结鼓励语
语言：简洁、专业、亲切。每条建议不超过2行。
格式：直接输出文字，可以使用emoji，不要使用markdown标题。`;

async function generateAnalysis() {
  const t = getTotals();
  const g = getGoals();
  const p = state.profile;

  if (state.todayLog.length === 0) {
    toast('请先记录今日饮食', 'error'); return;
  }
  if (!state.apiConfig || !getSecret('ai')) {
    toast('请先配置 API Key', 'error'); return;
  }

  const btn = document.getElementById('analysis-btn');
  btn.disabled = true;
  btn.textContent = '🤖 分析中...';
  document.getElementById('ai-advice').innerHTML = `
    <div style="padding:32px;text-align:center;">
      <div class="loading"><div class="dot"></div><div class="dot"></div><div class="dot"></div><span>AI 正在生成分析报告...</span></div>
    </div>`;

  const vd = viewingDate || getToday();
  const today = getToday();
  const dayLabel = vd === today ? '今日' : vd.slice(5);
  const userData = `
用户信息：${p?`${p.gender==='male'?'男':'女'}，${p.age}岁，${p.height}cm，${p.weight}kg，目标：${{lose:'减脂',maintain:'维持',gain:'增肌'}[p.goal]}`:'未填写'}
目标摄入：热量${g?.kcal||'未知'}kcal，蛋白${g?.protein||'未知'}g，脂肪${g?.fat||'未知'}g，碳水${g?.carbs||'未知'}g
${dayLabel}实际：热量${t.kcal}kcal，蛋白${t.protein}g，脂肪${t.fat}g，碳水${t.carbs}g，纤维${t.fiber}g
${dayLabel}食物：${state.todayLog.map(e=>e.foods.map(f=>f.name).join('、')).join('；')}`;

  try {
    const advice = await callLLM(userData, ANALYSIS_SYSTEM);
    // Render analysis items
    updateAnalysisSummary();
    document.getElementById('ai-advice').innerHTML = `
      <div style="line-height:1.8;font-size:14px;color:var(--text);white-space:pre-wrap;">${escapeHtml(advice)}</div>`;
    toast('✅ AI 分析完成', 'success');
  } catch(e) {
    document.getElementById('ai-advice').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
    toast('分析失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 重新生成分析';
  }
}

// ============================================================
//  WATER TRACKER
// ============================================================
const WATER_GOAL_DEFAULT = 2000; // ml

function getWaterGoal() {
  // Custom goal overrides auto-calculation
  if (state.waterGoal) return state.waterGoal;
  // Default: 2000ml, or based on body weight if profile is set (35ml per kg)
  if (state.profile && state.profile.weight) {
    return Math.round(state.profile.weight * 35);
  }
  return WATER_GOAL_DEFAULT;
}

function editWaterGoal() {
  const row = document.getElementById('water-goal-edit-row');
  const input = document.getElementById('water-goal-input');
  input.value = getWaterGoal();
  row.style.display = 'flex';
  input.focus();
  input.select();
}

function cancelEditWaterGoal() {
  document.getElementById('water-goal-edit-row').style.display = 'none';
}

function saveWaterGoal() {
  const input = document.getElementById('water-goal-input');
  const ml = parseInt(input.value);
  if (!ml || ml < 500 || ml > 10000) {
    toast('请输入有效的饮水目标（500-10000ml）', 'error');
    return;
  }
  state.waterGoal = ml;
  saveToStorage();
  cancelEditWaterGoal();
  renderWater();
  toast(`✅ 饮水目标已更新为 ${ml}ml`, 'success');
}

function getWaterTotal() {
  const d = viewingDate || getToday();
  const log = state.waterLogs?.[d];
  if (!log) return 0;
  return (log.records || []).reduce((s, r) => s + (r.ml || 0), 0);
}

function addWater(ml) {
  if (!ml || ml <= 0) return;
  const d = viewingDate || getToday();
  if (!state.waterLogs) state.waterLogs = {};
  if (!state.waterLogs[d]) state.waterLogs[d] = { total: 0, records: [] };
  state.waterLogs[d].records.push({ ml, time: new Date().toISOString() });
  state.waterLogs[d].total = state.waterLogs[d].records.reduce((s, r) => s + r.ml, 0);
  saveToStorage();
  renderWater();
  toast(`💧 已记录 ${ml}ml 饮水`, 'success');
}

function addCustomWater() {
  const input = document.getElementById('water-custom-ml');
  const ml = parseInt(input.value);
  if (!ml || ml <= 0 || ml > 5000) {
    toast('请输入有效的饮水量（1-5000ml）', 'error');
    return;
  }
  addWater(ml);
  input.value = '';
}

function deleteWaterRecord(idx) {
  const d = viewingDate || getToday();
  const log = state.waterLogs?.[d];
  if (!log || !log.records[idx]) return;
  const removed = log.records.splice(idx, 1)[0];
  log.total = log.records.reduce((s, r) => s + r.ml, 0);
  if (log.records.length === 0) delete state.waterLogs[d];
  saveToStorage();
  renderWater();
  toast(`已删除 ${removed.ml}ml 记录`, '');
}

function clearWaterToday() {
  const d = viewingDate || getToday();
  if (!state.waterLogs?.[d]?.records?.length) {
    toast('今日暂无饮水记录', ''); return;
  }
  if (!confirm('确定清除当前日期的所有饮水记录？')) return;
  delete state.waterLogs[d];
  saveToStorage();
  renderWater();
  toast('饮水记录已清除', '');
}

function renderWater() {
  const total = getWaterTotal();
  const goal = getWaterGoal();
  const pct = Math.min(100, Math.round(total / goal * 100));

  // Update amount
  document.getElementById('water-amount').textContent = total;
  document.getElementById('water-goal-text').textContent = goal;
  document.getElementById('water-goal-display').textContent = goal;

  // Update progress bar
  document.getElementById('water-progress').style.width = pct + '%';
  if (pct >= 100) {
    document.getElementById('water-progress').style.background = 'linear-gradient(90deg, var(--blue), var(--green))';
  } else {
    document.getElementById('water-progress').style.background = 'linear-gradient(90deg, var(--blue), #60a5fa)';
  }

  // Update cup visual
  const cupVisual = document.getElementById('water-cup-visual');
  const fillHeight = Math.min(100, Math.round(total / goal * 100));
  cupVisual.style.setProperty('--water-level', fillHeight + '%');
  // Set the before pseudo height via a style element
  let waterStyle = document.getElementById('water-dynamic-style');
  if (!waterStyle) {
    waterStyle = document.createElement('style');
    waterStyle.id = 'water-dynamic-style';
    document.head.appendChild(waterStyle);
  }
  waterStyle.textContent = `#water-cup-visual::before { height: ${fillHeight}%; }`;

  // Update wave position
  const waveEl = document.getElementById('water-wave-el');
  if (waveEl) {
    waveEl.style.display = fillHeight > 0 ? '' : 'none';
    waveEl.style.top = `calc(${fillHeight}% - 4px)`;
  }

  // Render records
  const container = document.getElementById('water-records');
  const d = viewingDate || getToday();
  const log = state.waterLogs?.[d];
  const records = log?.records || [];
  if (records.length === 0) {
    container.innerHTML = '';
    return;
  }
  // Show records in reverse order (newest first)
  let html = '';
  records.slice().reverse().forEach((r, revIdx) => {
    const realIdx = records.length - 1 - revIdx;
    const time = r.time ? new Date(r.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    html += `<div class="water-record-item">
      <span>💧 ${r.ml}ml <span style="color:var(--text3);font-size:11px;">${time}</span></span>
      <button class="water-record-del" data-action="deleteWaterRecord(${realIdx})" title="删除">×</button>
    </div>`;
  });
  container.innerHTML = html;
}

// ============================================================
//  HISTORY
// ============================================================
function setHistoryRange(days) {
  state.historyRange = days;
  document.getElementById('btn-7d').className  = days===7  ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('btn-30d').className = days===30 ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  renderHistoryChart();
  renderHistoryList();
  renderAvgNutrition();
}

function getHistoryDays(n) {
  const days = [];
  for (let i = n-1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0,10));
  }
  return days;
}

function renderHistoryChart() {
  const days = getHistoryDays(state.historyRange);
  // Save current viewing date's data
  const vd = viewingDate || getToday();
  if (state.todayLog.length > 0) {
    state.historyLogs[vd] = state.todayLog;
  }
  const labels = days.map(d => d.slice(5)); // MM-DD
  const kcals  = days.map(d => {
    const log = state.historyLogs[d] || [];
    return log.reduce((s, e) => s + (e.total?.kcal||0), 0);
  });
  const goalLine = state.targetKcal ? days.map(() => state.targetKcal) : null;

  const canvas = document.getElementById('historyChart');
  const datasets = [
    {
      label: '实际摄入 (kcal)',
      data: kcals,
      borderColor: 'rgba(108,99,255,0.9)',
      backgroundColor: 'rgba(108,99,255,0.15)',
      fill: true,
      tension: 0.4,
      pointBackgroundColor: 'var(--primary)',
      pointRadius: 4,
    }
  ];
  if (goalLine) datasets.push({
    label: '目标摄入 (kcal)',
    data: goalLine,
    borderColor: 'rgba(74,222,128,0.7)',
    borderDash: [6,3],
    borderWidth: 2,
    pointRadius: 0,
    fill: false,
  });

  if (historyChartInst) {
    historyChartInst.data.labels = labels;
    historyChartInst.data.datasets = datasets;
    historyChartInst.update();
    return;
  }
  historyChartInst = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: 'rgba(148,163,184,0.8)', font:{size:12} } } },
      scales: {
        x: { grid:{color:'rgba(46,51,88,0.6)'}, ticks:{color:'rgba(148,163,184,0.7)',font:{size:11}} },
        y: { grid:{color:'rgba(46,51,88,0.6)'}, ticks:{color:'rgba(148,163,184,0.7)',font:{size:11}}, beginAtZero:true }
      }
    }
  });
}

function renderHistoryList() {
  // Save current viewing date's data
  const vd = viewingDate || getToday();
  if (state.todayLog.length > 0) state.historyLogs[vd] = state.todayLog;

  const days = getHistoryDays(state.historyRange).reverse();
  const container = document.getElementById('history-list');
  const withData = days.filter(d => state.historyLogs[d] && state.historyLogs[d].length > 0);

  if (withData.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>暂无历史记录</p></div>`;
    renderAvgNutrition();
    return;
  }

  let html = '';
  withData.forEach(d => {
    const log = state.historyLogs[d];
    const total = log.reduce((s,e)=>({
      kcal: s.kcal+(e.total?.kcal||0),
      protein: s.protein+(e.total?.protein_g||0),
      fat: s.fat+(e.total?.fat_g||0),
      carbs: s.carbs+(e.total?.carbs_g||0),
    }), {kcal:0,protein:0,fat:0,carbs:0});

    const today = getToday();
    const isToday = d === today;
    const isViewing = d === vd;
    html += `
    <div style="border-bottom:1px solid var(--border);padding:12px 0;${isViewing?'background:rgba(108,99,255,.08);border-radius:8px;padding:12px 8px;':''}cursor:pointer;" data-action="selectDate('${d}');goPage('dashboard');" title="点击查看详情">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding:0 4px;">
        <span style="font-size:14px;font-weight:600;">${d.slice(5)} ${isToday?'<span style="font-size:11px;background:rgba(108,99,255,.2);color:var(--primary-light);padding:1px 6px;border-radius:4px;">今天</span>':''} ${isViewing&&!isToday?'<span style="font-size:11px;background:rgba(74,222,128,.2);color:var(--green);padding:1px 6px;border-radius:4px;">查看中</span>':''}</span>
        <span style="font-size:16px;font-weight:700;color:var(--primary-light)">${Math.round(total.kcal)} kcal</span>
      </div>
      <div style="display:flex;gap:14px;font-size:12px;color:var(--text2);padding:0 4px;">
        <span>蛋白 ${total.protein.toFixed(1)}g</span>
        <span>脂肪 ${total.fat.toFixed(1)}g</span>
        <span>碳水 ${total.carbs.toFixed(1)}g</span>
        <span>${log.length} 条记录</span>
      </div>
    </div>`;
  });
  container.innerHTML = html;
  renderAvgNutrition(withData);
}

function renderAvgNutrition(days) {
  const container = document.getElementById('avg-nutrition');
  if (!days || days.length < 2) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📊</div><p>需要2天以上记录才能计算平均值</p></div>`;
    return;
  }
  let sum = {kcal:0,protein:0,fat:0,carbs:0,fiber:0,n:0};
  days.forEach(d => {
    const log = state.historyLogs[d] || [];
    log.forEach(e => {
      sum.kcal    += e.total?.kcal||0;
      sum.protein += e.total?.protein_g||0;
      sum.fat     += e.total?.fat_g||0;
      sum.carbs   += e.total?.carbs_g||0;
      sum.fiber   += e.total?.fiber_g||0;
    });
    sum.n++;
  });
  const n = sum.n||1;
  const g = getGoals();
  const items = [
    {label:'🔥 平均热量', val:Math.round(sum.kcal/n), goal:g?.kcal, unit:'kcal'},
    {label:'💪 平均蛋白', val:(sum.protein/n).toFixed(1), goal:g?.protein, unit:'g'},
    {label:'🧈 平均脂肪', val:(sum.fat/n).toFixed(1), goal:g?.fat, unit:'g'},
    {label:'🌾 平均碳水', val:(sum.carbs/n).toFixed(1), goal:g?.carbs, unit:'g'},
    {label:'🌿 平均纤维', val:(sum.fiber/n).toFixed(1), goal:25, unit:'g'},
  ];
  let html = '';
  items.forEach(item => {
    const pct = item.goal ? Math.round(item.val/item.goal*100) : null;
    const color = pct===null?'var(--text)':pct<70?'var(--red)':pct<90?'var(--yellow)':pct>115?'var(--orange)':'var(--green)';
    html += `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:14px;">${item.label}</span>
      <span style="font-size:15px;font-weight:700;color:${color}">${item.val} ${item.unit}
        ${pct!==null?`<span style="font-size:11px;color:var(--text3)"> ${pct}%</span>`:''}
      </span>
    </div>`;
  });
  html += `<div style="font-size:12px;color:var(--text3);margin-top:8px;">统计来自 ${n} 天的记录</div>`;
  container.innerHTML = html;
}

// ============================================================
//  GOAL & BODY TRACKER
// ============================================================

function selectGoalType(type) {
  document.querySelectorAll('#goal-type-btns .goal-type-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-type') === type);
  });
  document.getElementById('goal-target-weight-group').style.display = type === 'maintain' ? 'none' : '';
}

function saveGoal() {
  const type = document.querySelector('#goal-type-btns .goal-type-btn.active')?.getAttribute('data-type') || 'lose';
  const currentWeight = boundedNumber(document.getElementById('goal-current-weight').value, 30, 500);
  let targetWeight = type === 'maintain'
    ? currentWeight
    : boundedNumber(document.getElementById('goal-target-weight').value, 30, 500);
  const weeks = boundedNumber(document.getElementById('goal-weeks').value, 1, 260);
  const targetBfRaw = document.getElementById('goal-target-bf').value;
  const targetBF = targetBfRaw ? boundedNumber(targetBfRaw, 1, 70) : null;

  if (currentWeight === null || targetWeight === null || weeks === null || (targetBfRaw && targetBF === null)) {
    toast('请检查体重、周期和目标体脂范围', 'error');
    return;
  }
  if (type !== 'maintain' && (!targetWeight || targetWeight < 30)) {
    toast('请填写目标体重', 'error');
    return;
  }
  if (type === 'lose' && targetWeight >= currentWeight) {
    toast('减脂目标体重应小于当前体重', 'error');
    return;
  }
  if (type === 'gain' && targetWeight <= currentWeight) {
    toast('增肌目标体重应大于当前体重', 'error');
    return;
  }

  // Calculate recommended intake
  const tdee = state.tdee || (state.bmr * 1.55);
  let recKcal, recProtein;
  if (type === 'lose') {
    recKcal = tdee - 400;
    recProtein = Math.round(currentWeight * 2.0); // 2g/kg
  } else if (type === 'gain') {
    recKcal = tdee + 300;
    recProtein = Math.round(currentWeight * 1.8); // 1.8g/kg
  } else {
    recKcal = tdee;
    recProtein = Math.round(currentWeight * 1.5); // 1.5g/kg
  }

  state.fitnessGoal = {
    type,
    currentWeight,
    targetWeight: type === 'maintain' ? currentWeight : targetWeight,
    targetBF,
    weeks,
    startDate: getToday(),
    recKcal: Math.round(recKcal),
    recProtein,
  };

  // Update targetKcal for dashboard
  state.targetKcal = state.fitnessGoal.recKcal;
  saveToStorage();
  updateDashboard();

  // Show recommendation
  renderGoalRecommendation();
  renderGoalProgress();
  toast('🎯 目标已保存，推荐热量已更新！', 'success');
}

function renderGoalRecommendation() {
  const g = state.fitnessGoal;
  if (!g) return;
  const el = document.getElementById('goal-recommendation');
  el.style.display = '';
  const goalLabel = { lose: '减脂', gain: '增肌', maintain: '维持' }[g.type];
  const deficitLabel = { lose: '热量缺口约 400 kcal', gain: '热量盈余约 300 kcal', maintain: '热量持平' }[g.type];
  let html = `<div style="display:flex;gap:16px;margin-bottom:12px;">
    <div style="flex:1;background:var(--bg);border-radius:10px;padding:14px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:var(--green);">${g.recKcal}</div>
      <div style="font-size:12px;color:var(--text3);">推荐每日摄入 kcal</div>
    </div>
    <div style="flex:1;background:var(--bg);border-radius:10px;padding:14px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:var(--blue);">${g.recProtein}</div>
      <div style="font-size:12px;color:var(--text3);">推荐每日蛋白质 g</div>
    </div>
  </div>`;
  html += `<div><strong>策略：</strong>${goalLabel}模式，${deficitLabel}</div>`;
  if (g.type !== 'maintain') {
    const totalChange = Math.abs(g.targetWeight - g.currentWeight);
    const weeklyRate = (totalChange / g.weeks).toFixed(2);
    html += `<div><strong>每周目标：</strong>${g.type === 'lose' ? '减' : '增'}约 ${weeklyRate} kg</div>`;
    html += `<div><strong>预计完成：</strong>${g.weeks} 周</div>`;
  }
  document.getElementById('goal-rec-content').innerHTML = html;
}

function renderGoalProgress() {
  const container = document.getElementById('goal-progress-content');
  const g = state.fitnessGoal;
  if (!g) {
    container.innerHTML = '<div class="empty-state"><div class="icon">🎯</div><p>设置目标后<br>这里将展示你的进展情况</p></div>';
    return;
  }

  const records = state.bodyRecords || [];
  const latestRecord = records.length > 0 ? records[records.length - 1] : null;
  const currentW = latestRecord ? latestRecord.weight : g.currentWeight;
  const totalToChange = Math.abs(g.targetWeight - g.currentWeight);
  const changed = g.type === 'lose' ? (g.currentWeight - currentW) : (currentW - g.currentWeight);
  const pct = totalToChange > 0 ? Math.min(100, Math.max(0, (changed / totalToChange) * 100)) : 0;

  // Days elapsed
  const startD = new Date(g.startDate + 'T00:00:00');
  const today = new Date();
  const daysElapsed = Math.max(0, Math.floor((today - startD) / 86400000));
  const daysTotal = g.weeks * 7;
  const dayPct = Math.min(100, (daysElapsed / daysTotal) * 100);

  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (pct / 100) * circumference;

  const color = g.type === 'lose' ? 'var(--green)' : g.type === 'gain' ? 'var(--blue)' : 'var(--yellow)';

  let html = `<div style="display:flex;gap:24px;align-items:center;margin-bottom:20px;">
    <div class="goal-progress-ring">
      <svg viewBox="0 0 120 120">
        <circle class="ring-bg" cx="60" cy="60" r="52"></circle>
        <circle class="ring-fill" cx="60" cy="60" r="52"
          stroke="${color}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"></circle>
      </svg>
      <div class="goal-ring-text">
        <div class="goal-ring-pct" style="color:${color}">${pct.toFixed(0)}%</div>
        <div class="goal-ring-label">目标完成</div>
      </div>
    </div>
    <div style="flex:1;">
      <div style="font-size:13px;color:var(--text2);margin-bottom:6px;">
        <strong>${g.type === 'lose' ? '减脂' : g.type === 'gain' ? '增肌' : '维持'}</strong> ·
        ${g.currentWeight}kg → ${g.targetWeight}kg
      </div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">
        起始体重：<strong>${g.currentWeight} kg</strong>
      </div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">
        当前体重：<strong>${currentW.toFixed(1)} kg</strong>
      </div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">
        已${g.type === 'lose' ? '减轻' : g.type === 'gain' ? '增加' : ''}：<strong style="color:${color}">${changed.toFixed(1)} kg</strong>
      </div>
      <div style="font-size:13px;color:var(--text2);">
        剩余：<strong>${Math.abs(currentW - g.targetWeight).toFixed(1)} kg</strong>
      </div>
    </div>
  </div>`;

  // Time progress bar
  html += `<div style="margin-bottom:16px;">
    <div class="progress-header">
      <span class="progress-name">📅 时间进度</span>
      <span class="progress-val">${daysElapsed} / ${daysTotal} 天</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" style="width:${dayPct}%;background:var(--primary);"></div>
    </div>
  </div>`;

  // Calorie recommendation
  html += `<div style="background:var(--bg);border-radius:10px;padding:14px;display:flex;gap:16px;">
    <div style="flex:1;text-align:center;">
      <div style="font-size:18px;font-weight:800;color:var(--green);">${g.recKcal}</div>
      <div style="font-size:11px;color:var(--text3);">每日热量目标</div>
    </div>
    <div style="flex:1;text-align:center;">
      <div style="font-size:18px;font-weight:800;color:var(--blue);">${g.recProtein}g</div>
      <div style="font-size:11px;color:var(--text3);">每日蛋白质</div>
    </div>
    <div style="flex:1;text-align:center;">
      <div style="font-size:18px;font-weight:800;color:var(--orange);">${(totalToChange / g.weeks).toFixed(2)}</div>
      <div style="font-size:11px;color:var(--text3);">周目标 kg</div>
    </div>
  </div>`;

  container.innerHTML = html;
}

// ---- Body Data Recording ----

function addBodyRecord() {
  const weight = boundedNumber(document.getElementById('body-weight').value, 30, 500);
  const bodyFatRaw = document.getElementById('body-fat').value;
  const waistRaw = document.getElementById('body-waist').value;
  const bodyFat = bodyFatRaw ? boundedNumber(bodyFatRaw, 1, 70) : null;
  const waist = waistRaw ? boundedNumber(waistRaw, 20, 300) : null;
  const note = document.getElementById('body-note').value.trim();

  if (weight === null || (bodyFatRaw && bodyFat === null) || (waistRaw && waist === null) || note.length > 500) {
    toast('请检查体重、体脂、腰围或备注长度', 'error');
    return;
  }

  const date = getToday();
  const record = {
    date,
    weight,
    bodyFat,
    waist,
    note,
    time: new Date().toISOString(),
  };

  if (!state.bodyRecords) state.bodyRecords = [];
  state.bodyRecords.push(record);
  // Sort by date
  state.bodyRecords.sort((a, b) => a.date.localeCompare(b.date));

  saveToStorage();

  // Clear inputs
  document.getElementById('body-weight').value = '';
  document.getElementById('body-fat').value = '';
  document.getElementById('body-waist').value = '';
  document.getElementById('body-note').value = '';

  renderBodyPage();
  toast('✅ 身体数据已记录', 'success');
}

function deleteBodyRecord(idx) {
  state.bodyRecords.splice(idx, 1);
  saveToStorage();
  renderBodyPage();
  toast('已删除记录', '');
}

// ---- Body Page Rendering ----

function renderBodyPage() {
  // Restore goal form
  const g = state.fitnessGoal;
  if (g) {
    selectGoalType(g.type);
    document.getElementById('goal-current-weight').value = g.currentWeight || '';
    document.getElementById('goal-target-weight').value = g.targetWeight || '';
    document.getElementById('goal-weeks').value = g.weeks || 8;
    document.getElementById('goal-target-bf').value = g.targetBF || '';
    renderGoalRecommendation();
  }
  renderGoalProgress();
  renderBodyTable();
  renderBodyChart();
}

function renderBodyTable() {
  const records = state.bodyRecords || [];
  const tbody = document.getElementById('body-table-body');
  const emptyEl = document.getElementById('body-table-empty');
  const countEl = document.getElementById('body-records-count');

  if (records.length === 0) {
    tbody.innerHTML = '';
    emptyEl.style.display = '';
    countEl.textContent = '';
    return;
  }

  emptyEl.style.display = 'none';
  countEl.textContent = `共 ${records.length} 条记录`;

  let html = '';
  // Show in reverse order (newest first)
  const reversed = [...records].reverse();
  reversed.forEach((r, ri) => {
    const idx = records.length - 1 - ri;
    const prev = idx > 0 ? records[idx - 1] : null;
    const change = prev ? (r.weight - prev.weight) : 0;
    let changeClass = 'change-flat';
    let changeText = '--';
    if (prev) {
      if (change > 0.05) { changeClass = 'change-positive'; changeText = `+${change.toFixed(1)}`; }
      else if (change < -0.05) { changeClass = 'change-negative'; changeText = `${change.toFixed(1)}`; }
      else { changeText = '0.0'; }
    }

    const today = getToday();
    const isToday = r.date === today;
    html += `<tr>
      <td style="font-weight:500;color:var(--text);">${r.date.slice(5)}${isToday ? ' <span style="font-size:10px;background:rgba(108,99,255,.2);color:var(--primary-light);padding:1px 5px;border-radius:3px;">今</span>' : ''}</td>
      <td class="weight-val">${r.weight.toFixed(1)}</td>
      <td class="${changeClass}">${changeText}</td>
      <td>${r.bodyFat ? r.bodyFat.toFixed(1) + '%' : '-'}</td>
      <td>${r.waist ? r.waist + ' cm' : '-'}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.note || ''}">${r.note || '-'}</td>
      <td><button class="del-btn" data-action="deleteBodyRecord(${idx})" title="删除">🗑️</button></td>
    </tr>`;
  });
  tbody.innerHTML = html;
}

// ---- Body Chart ----

function setBodyChartRange(days, btn) {
  state.bodyChartRange = days;
  document.querySelectorAll('#body-chart-range .chart-range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderBodyChart();
}

function renderBodyChart() {
  const records = state.bodyRecords || [];
  const canvas = document.getElementById('bodyChart');
  const emptyEl = document.getElementById('body-chart-empty');

  if (records.length < 2) {
    canvas.style.display = 'none';
    emptyEl.style.display = '';
    if (bodyChartInst) { bodyChartInst.destroy(); bodyChartInst = null; }
    return;
  }
  canvas.style.display = '';
  emptyEl.style.display = 'none';

  // Filter by range
  let filtered = records;
  if (state.bodyChartRange > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - state.bodyChartRange);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    filtered = records.filter(r => r.date >= cutoffStr);
  }
  if (filtered.length < 1) filtered = records.slice(-7);

  const labels = filtered.map(r => r.date.slice(5));
  const weights = filtered.map(r => r.weight);
  const bodyFats = filtered.map(r => r.bodyFat);

  const datasets = [{
    label: '体重 (kg)',
    data: weights,
    borderColor: 'rgba(108,99,255,0.9)',
    backgroundColor: 'rgba(108,99,255,0.15)',
    fill: true,
    tension: 0.3,
    pointBackgroundColor: '#6c63ff',
    pointRadius: 4,
    pointHoverRadius: 6,
    yAxisID: 'y',
  }];

  // Add body fat line if available
  const hasBF = bodyFats.some(v => v !== null && v !== undefined);
  if (hasBF) {
    datasets.push({
      label: '体脂率 (%)',
      data: bodyFats,
      borderColor: 'rgba(244,114,182,0.8)',
      backgroundColor: 'rgba(244,114,182,0.1)',
      borderDash: [5, 3],
      fill: false,
      tension: 0.3,
      pointBackgroundColor: '#f472b6',
      pointRadius: 3,
      pointHoverRadius: 5,
      yAxisID: 'y1',
    });
  }

  // Add target weight line
  const g = state.fitnessGoal;
  if (g && g.type !== 'maintain') {
    datasets.push({
      label: '目标体重',
      data: filtered.map(() => g.targetWeight),
      borderColor: 'rgba(74,222,128,0.6)',
      borderDash: [8, 4],
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      yAxisID: 'y',
    });
  }

  const scales = {
    x: { grid: { color: 'rgba(46,51,88,0.6)' }, ticks: { color: 'rgba(148,163,184,0.7)', font: { size: 11 } } },
    y: { position: 'left', grid: { color: 'rgba(46,51,88,0.6)' }, ticks: { color: 'rgba(148,163,184,0.7)', font: { size: 11 } }, title: { display: true, text: '体重 (kg)', color: 'rgba(148,163,184,0.5)', font: { size: 11 } } }
  };
  if (hasBF) {
    scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: 'rgba(244,114,182,0.6)', font: { size: 11 } }, title: { display: true, text: '体脂 (%)', color: 'rgba(244,114,182,0.5)', font: { size: 11 } } };
  }

  if (bodyChartInst) {
    bodyChartInst.data.labels = labels;
    bodyChartInst.data.datasets = datasets;
    bodyChartInst.options.scales = scales;
    bodyChartInst.update();
    return;
  }

  bodyChartInst = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: 'rgba(148,163,184,0.8)', font: { size: 12 } } } },
      scales,
    }
  });
}

// ---- AI Progress Assessment ----

function generateBodyInsights() {
  const records = state.bodyRecords || [];
  const container = document.getElementById('body-insights');
  const btn = document.getElementById('body-insight-btn');

  if (records.length < 3) {
    toast('至少需要 3 天的体重记录才能分析', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ 分析中...';
  container.innerHTML = '<div class="loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span> 正在分析...</div>';

  // Local analysis first (always works)
  const localInsights = analyzeLocalProgress(records);
  renderLocalInsights(container, localInsights);

  // Try AI analysis if API is configured
  if (state.apiConfig && getSecret('ai')) {
    analyzeWithAI(records, localInsights).then(aiHtml => {
      if (aiHtml) {
        container.innerHTML = localInsightsHtml(localInsights) + '<hr class="divider"><div class="settings-title" style="margin-bottom:12px;">🤖 AI 深度分析</div>' + aiHtml;
      }
      btn.disabled = false;
      btn.textContent = '🤖 AI 智能分析';
    }).catch(() => {
      btn.disabled = false;
      btn.textContent = '🤖 AI 智能分析';
    });
  } else {
    btn.disabled = false;
    btn.textContent = '🤖 AI 智能分析';
  }
}

function analyzeLocalProgress(records) {
  const insights = [];
  if (records.length < 2) return insights;

  const latest = records[records.length - 1];
  const first = records[0];
  const totalChange = latest.weight - first.weight;
  const totalDays = Math.max(1, Math.floor((new Date(latest.date) - new Date(first.date)) / 86400000));
  const weeklyRate = (totalChange / totalDays) * 7;

  // Overall trend
  insights.push({
    type: 'info',
    title: '📊 整体趋势',
    desc: `从 ${first.weight.toFixed(1)}kg → ${latest.weight.toFixed(1)}kg，共 ${totalDays} 天，变化 ${totalChange > 0 ? '+' : ''}${totalChange.toFixed(1)}kg（每周约 ${weeklyRate > 0 ? '+' : ''}${weeklyRate.toFixed(2)}kg）`
  });

  // Recent 7 days
  if (records.length >= 3) {
    const recent7 = records.slice(-7);
    const first7 = recent7[0];
    const last7 = recent7[recent7.length - 1];
    const change7 = last7.weight - first7.weight;
    const days7 = Math.max(1, Math.floor((new Date(last7.date) - new Date(first7.date)) / 86400000));
    const rate7 = (change7 / days7) * 7;

    // Platform detection
    if (Math.abs(change7) < 0.3 && days7 >= 5) {
      insights.push({
        type: 'warning',
        title: '⚠️ 可能进入平台期',
        desc: `最近 ${days7} 天体重仅变化 ${change7 > 0 ? '+' : ''}${change7.toFixed(1)}kg，几乎没有明显变化。建议：适当调整热量缺口（±100kcal）、增加运动量或改变训练方式，打破代谢适应。`
      });
    } else if (Math.abs(change7) < 0.8 && days7 >= 5) {
      insights.push({
        type: 'warning',
        title: '⚠️ 进展放缓',
        desc: `最近 ${days7} 天体重变化 ${change7 > 0 ? '+' : ''}${change7.toFixed(1)}kg（每周约 ${rate7 > 0 ? '+' : ''}${rate7.toFixed(2)}kg），速度较慢。`
      });
    } else {
      const g = state.fitnessGoal;
      if (g && g.type === 'lose' && change7 < -0.5) {
        insights.push({
          type: 'good',
          title: '✅ 减重进展良好',
          desc: `最近 ${days7} 天减轻了 ${Math.abs(change7).toFixed(1)}kg，减重速度健康合理（每周约 ${Math.abs(rate7).toFixed(2)}kg）。`
        });
      } else if (g && g.type === 'gain' && change7 > 0.3) {
        insights.push({
          type: 'good',
          title: '✅ 增重进展良好',
          desc: `最近 ${days7} 天增加了 ${change7.toFixed(1)}kg，增重速度合理。注意控制增量主要是肌肉而非脂肪。`
        });
      } else if (change7 < 0) {
        insights.push({
          type: 'good',
          title: '📉 体重下降中',
          desc: `最近 ${days7} 天体重减轻 ${Math.abs(change7).toFixed(1)}kg。`
        });
      } else {
        insights.push({
          type: 'info',
          title: '📊 最近趋势',
          desc: `最近 ${days7} 天体重变化 ${change7 > 0 ? '+' : ''}${change7.toFixed(1)}kg。`
        });
      }
    }

    // Check consistency (standard deviation)
    if (recent7.length >= 4) {
      const ws = recent7.map(r => r.weight);
      const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
      const stdDev = Math.sqrt(ws.reduce((sum, w) => sum + (w - mean) ** 2, 0) / ws.length);
      if (stdDev > 1.0) {
        insights.push({
          type: 'warning',
          title: '📈 体重波动较大',
          desc: `近期体重标准差为 ${stdDev.toFixed(2)}kg，波动较大。建议每天固定时间（如晨起排便后）测量，减少外部因素影响。`
        });
      }
    }
  }

  // Goal comparison
  const g = state.fitnessGoal;
  if (g && g.type !== 'maintain') {
    const remaining = Math.abs(latest.weight - g.targetWeight);
    const totalToLose = Math.abs(g.currentWeight - g.targetWeight);
    const progressPct = totalToLose > 0 ? Math.max(0, ((g.currentWeight - latest.weight) * (g.type === 'lose' ? 1 : -1)) / totalToLose * 100) : 0;

    if (progressPct >= 100) {
      insights.push({
        type: 'good',
        title: '🎉 恭喜！目标已达成',
        desc: `当前体重 ${latest.weight.toFixed(1)}kg 已达到目标体重 ${g.targetWeight}kg！`
      });
    } else if (progressPct > 50) {
      insights.push({
        type: 'good',
        title: '🔥 进度过半',
        desc: `已完成目标的 ${progressPct.toFixed(0)}%，距离目标还剩 ${remaining.toFixed(1)}kg，继续加油！`
      });
    }

    // Pace check
    if (g.startDate) {
      const elapsed = Math.max(1, Math.floor((new Date() - new Date(g.startDate + 'T00:00:00')) / 86400000));
      const expectedChange = (totalToLose / (g.weeks * 7)) * elapsed;
      const actualChange = (g.currentWeight - latest.weight) * (g.type === 'lose' ? 1 : -1);
      const pacePct = expectedChange > 0 ? (actualChange / expectedChange * 100) : 100;

      if (pacePct > 120) {
        insights.push({
          type: 'good',
          title: '🚀 超前于计划',
          desc: `当前进度领先计划 ${((pacePct - 100) / 100 * elapsed).toFixed(0)} 天，继续保持！`
        });
      } else if (pacePct < 70) {
        insights.push({
          type: 'danger',
          title: '🐢 落后于计划',
          desc: `当前进度落后计划约 ${((100 - pacePct) / 100 * elapsed).toFixed(0)} 天，建议审视饮食或增加运动量。`
        });
      } else {
        insights.push({
          type: 'info',
          title: '⏱️ 按计划进行中',
          desc: `进度符合预期，当前速度与计划基本一致。`
        });
      }
    }
  }

  return insights;
}

function localInsightsHtml(insights) {
  if (insights.length === 0) return '<div class="empty-state"><div class="icon">🤔</div><p>数据不足，继续记录</p></div>';
  return insights.map(i => `<div class="insight-card ${escapeHtml(i.type)}"><div class="insight-title">${escapeHtml(i.title)}</div><div class="insight-desc">${escapeHtml(i.desc)}</div></div>`).join('');
}

function renderLocalInsights(container, insights) {
  container.innerHTML = '<div class="settings-title" style="margin-bottom:12px;">📊 系统分析</div>' + localInsightsHtml(insights);
}

async function analyzeWithAI(records, localInsights) {
  const g = state.fitnessGoal;
  const recent = records.slice(-14);
  const weightData = recent.map(r => `${r.date.slice(5)}: ${r.weight}kg${r.bodyFat ? `, 体脂${r.bodyFat}%` : ''}`).join('\n');

  const prompt = `你是一位专业的健身营养教练。根据用户以下身体数据，给出简洁专业的进展分析和建议（200字以内，使用中文）。

目标：${g ? `${{lose:'减脂',gain:'增肌',maintain:'维持'}[g.type]}，${g.currentWeight}kg→${g.targetWeight}kg，${g.weeks}周` : '未设置'}
推荐热量：${g ? g.recKcal + 'kcal' : '未设置'}，推荐蛋白质：${g ? g.recProtein + 'g' : '未设置'}

近期体重记录：
${weightData}

系统分析结果：
${localInsights.map(i => `${i.title}：${i.desc}`).join('\n')}

请给出：
1. 进展评价（是否正常）
2. 饮食/训练调整建议
3. 预期达到目标的时间
用简洁的中文回答，不要使用 markdown 格式。`;

  try {
    const resp = await callLLM(prompt, '你是一位专业的健身营养教练。请用简洁专业的中文回答。');
    return `<div class="insight-card info"><div class="insight-title">🤖 AI 建议</div><div class="insight-desc">${escapeHtml(resp).replace(/\n/g, '<br>')}</div></div>`;
  } catch (e) {
    return null;
  }
}

// ---- Load body page state from storage ----
function loadBodyPageState() {
  const g = state.fitnessGoal;
  if (g) {
    selectGoalType(g.type);
    document.getElementById('goal-current-weight').value = g.currentWeight || '';
    document.getElementById('goal-target-weight').value = g.targetWeight || '';
    document.getElementById('goal-weeks').value = g.weeks || 8;
    document.getElementById('goal-target-bf').value = g.targetBF || '';
  }
}

// ============================================================
//  FOOD DATABASE
// ============================================================
function renderFoodDb() {
  const query = (document.getElementById('fooddb-search')?.value || '').trim().toLowerCase();
  const list = (state.foodDb || []).filter(f => !query || f.name.toLowerCase().includes(query));
  const container = document.getElementById('fooddb-list');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = query
      ? `<div class="empty-state"><div class="icon">🔍</div><p>没有找到"${escapeHtml(query)}"相关的食物</p></div>`
      : `<div class="empty-state"><div class="icon">🗂️</div><p>还没有自定义食物，点击上方「添加食物」开始创建</p></div>`;
    return;
  }
  container.innerHTML = list.map(f => {
    const unit = f.portionUnit || 'g';
    const portionText = f.portionDesc ? `${f.portionDesc}${f.portionG ? '（' + f.portionG + unit + '）' : ''}` : (f.portionG ? f.portionG + unit + '/份' : '');
    return `<div class="fooddb-card">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="fooddb-name">${escapeHtml(f.name)}</span>
          ${portionText ? `<span class="fooddb-badge">📦 ${escapeHtml(portionText)}</span>` : ''}
        </div>
        <div class="fooddb-nutrients">
          <span class="fooddb-nutrient">热量 <span>${f.kcalPer100}</span> kcal</span>
          <span class="fooddb-nutrient">蛋白质 <span>${f.proteinPer100}</span>g</span>
          <span class="fooddb-nutrient">脂肪 <span>${f.fatPer100}</span>g</span>
          <span class="fooddb-nutrient">碳水 <span>${f.carbsPer100}</span>g</span>
          <span class="fooddb-nutrient">纤维 <span>${f.fiberPer100}</span>g</span>
          <span class="fooddb-nutrient" style="color:var(--text3)">（以上为每100g数据）</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" data-action="openFoodDbModal('${encodeURIComponent(f.id)}')">✏️</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" data-action="deleteFoodDbEntry('${encodeURIComponent(f.id)}')">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function updateFdbUnitLabel() {
  const unit = document.getElementById('fdb-portion-unit')?.value || 'g';
  const label = document.getElementById('fdb-per100-label');
  if (label) label.textContent = unit === 'ml' ? '📊 每 100ml 的营养数据' : '📊 每 100g 的营养数据';
}

function openFoodDbModal(id) {
  const overlay = document.getElementById('fooddb-modal-overlay');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (id) {
    const entry = (state.foodDb || []).find(f => f.id === id);
    if (!entry) return;
    document.getElementById('fooddb-modal-title').textContent = '✏️ 编辑食物';
    document.getElementById('fooddb-edit-id').value = id;
    document.getElementById('fdb-name').value = entry.name;
    document.getElementById('fdb-portion-desc').value = entry.portionDesc || '';
    document.getElementById('fdb-portion-g').value = entry.portionG || '';
    document.getElementById('fdb-portion-unit').value = entry.portionUnit || 'g';
    document.getElementById('fdb-kcal').value = entry.kcalPer100;
    document.getElementById('fdb-protein').value = entry.proteinPer100;
    document.getElementById('fdb-fat').value = entry.fatPer100;
    document.getElementById('fdb-carbs').value = entry.carbsPer100;
    document.getElementById('fdb-fiber').value = entry.fiberPer100;
  } else {
    document.getElementById('fooddb-modal-title').textContent = '➕ 添加自定义食物';
    document.getElementById('fooddb-edit-id').value = '';
    ['fdb-name','fdb-portion-desc','fdb-portion-g','fdb-kcal','fdb-protein','fdb-fat','fdb-carbs','fdb-fiber'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('fdb-portion-unit').value = 'g';
  }
  updateFdbUnitLabel();
}

function closeFoodDbModal() {
  document.getElementById('fooddb-modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function saveFoodDbEntry() {
  const name = document.getElementById('fdb-name').value.trim();
  if (!name || name.length > 100) { toast('食物名称需为1-100字', 'error'); return; }
  const kcal = boundedNumber(document.getElementById('fdb-kcal').value || 0, 0, 20000);
  const protein = boundedNumber(document.getElementById('fdb-protein').value || 0, 0, 2000);
  const fat = boundedNumber(document.getElementById('fdb-fat').value || 0, 0, 2000);
  const carbs = boundedNumber(document.getElementById('fdb-carbs').value || 0, 0, 5000);
  const fiber = boundedNumber(document.getElementById('fdb-fiber').value || 0, 0, 1000);
  const portionDesc = document.getElementById('fdb-portion-desc').value.trim();
  const portionG = boundedNumber(document.getElementById('fdb-portion-g').value || 0, 0, 10000);
  const portionUnit = document.getElementById('fdb-portion-unit').value || 'g';

  if ([kcal, protein, fat, carbs, fiber, portionG].some(value => value === null) || portionDesc.length > 100) {
    toast('食物营养数值或份量描述超出允许范围', 'error'); return;
  }

  if (!state.foodDb) state.foodDb = [];
  const editId = document.getElementById('fooddb-edit-id').value;
  if (editId) {
    const idx = state.foodDb.findIndex(f => f.id === editId);
    if (idx >= 0) {
      state.foodDb[idx] = { ...state.foodDb[idx], name, portionDesc, portionG, portionUnit, kcalPer100: kcal, proteinPer100: protein, fatPer100: fat, carbsPer100: carbs, fiberPer100: fiber };
    }
    toast('✅ 已更新食物数据', 'success');
  } else {
    const newEntry = {
      id: 'fdb_' + Date.now(),
      name, portionDesc, portionG, portionUnit,
      kcalPer100: kcal, proteinPer100: protein, fatPer100: fat, carbsPer100: carbs, fiberPer100: fiber
    };
    state.foodDb.push(newEntry);
    toast('✅ 已添加到食物库', 'success');
  }
  saveToStorage();
  debouncedCloudSave();
  closeFoodDbModal();
  renderFoodDb();
}

function deleteFoodDbEntry(id) {
  if (!confirm('确认删除此食物？')) return;
  state.foodDb = (state.foodDb || []).filter(f => f.id !== id);
  saveToStorage();
  debouncedCloudSave();
  renderFoodDb();
  toast('已删除', '');
}

// Fuzzy match food name against foodDb
// Returns matched entry or null
function matchFoodDb(name) {
  if (!state.foodDb || !state.foodDb.length) return null;
  const n = name.toLowerCase().replace(/\s/g, '');
  // Exact match first
  let match = state.foodDb.find(f => f.name.toLowerCase().replace(/\s/g, '') === n);
  if (match) return match;
  // Contains match
  match = state.foodDb.find(f => n.includes(f.name.toLowerCase().replace(/\s/g, '')) || f.name.toLowerCase().replace(/\s/g, '').includes(n));
  return match || null;
}

// ============================================================
//  TOAST
// ============================================================
function toast(msg, type) {
  const el = document.getElementById('toast');
  const icons = { success: '✅', error: '❌', '': 'ℹ️' };
  el.textContent = `${icons[type]||'ℹ️'} ${String(msg ?? '')}`;
  el.className = `toast show ${type||''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// CSP-safe replacement for legacy inline event attributes. Only explicitly
// allowed application actions can be invoked; arbitrary code is never run.
const UI_ACTIONS = {
  addBodyRecord, addCustomWater, addModalFoodRow, addToLog, addWater,
  cancelEditWaterGoal, changeCalMonth, clearWaterToday, closeAuthModal,
  closeFoodDbModal, closeFoodModal, deleteAccountAndData, deleteBodyRecord,
  deleteCloudData, deleteFoodDbEntry,
  deleteLogEntry, deleteWaterRecord, editLogEntry, editWaterGoal, fillExample,
  exportData, generateAnalysis, generateBodyInsights, goPage, goToToday,
  handleAuth, importData, openAuthModal, openFoodDbModal, openImportPicker,
  openManualAdd, removeModalFood, renderFoodDb, resetAllData,
  saveApiConfig, saveFoodDbEntry, saveFoodModal, saveGoal, saveProfile,
  saveUsdaKey, saveWaterGoal, selectDate, selectGoalType, selectMeal,
  selectModalMeal, sendFoodMessage, setBodyChartRange, setHistoryRange,
  shiftDate, testApiConfig, toggleAuthMode, toggleDateCalendar,
  updateApiPlaceholder, updateFdbUnitLabel
  , toggleTheme
};

function parseActionArg(raw, element) {
  const value = raw.trim();
  if (value === 'this') return element;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^'([^']*)'$/);
  if (quoted) return decodeURIComponent(quoted[1]);
  throw new Error('Unsupported UI action argument');
}

function runUiAction(expression, element, event) {
  if (expression === "window.open('https://fdc.nal.usda.gov/api-key-signup.html','_blank')") {
    window.open('https://fdc.nal.usda.gov/api-key-signup.html', '_blank', 'noopener,noreferrer');
    return;
  }
  if (expression.startsWith('if(event.target===this)')) {
    if (event.target !== element) return;
    expression = expression.slice('if(event.target===this)'.length);
  }
  for (const statement of expression.split(';').map(x => x.trim()).filter(Boolean)) {
    const match = statement.match(/^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/);
    if (!match || !UI_ACTIONS[match[1]]) throw new Error('Unsupported UI action');
    const args = match[2].trim()
      ? match[2].split(',').map(arg => parseActionArg(arg, element))
      : [];
    UI_ACTIONS[match[1]](...args);
  }
}

document.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  runUiAction(element.dataset.action, element, event);
});

document.addEventListener('change', event => {
  const element = event.target.closest('[data-change-action]');
  if (!element) return;
  runUiAction(element.dataset.changeAction, element, event);
});

document.addEventListener('input', event => {
  const element = event.target.closest('[data-input-action]');
  if (!element) return;
  runUiAction(element.dataset.inputAction, element, event);
});

document.addEventListener('keydown', event => {
  const clickable = event.target.closest('[data-action]');
  if (clickable && !clickable.matches('button, a, input, select, textarea') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    clickable.click();
    return;
  }
  const element = event.target.closest('[data-key-action]');
  if (!element) return;
  const action = element.dataset.keyAction;
  if (action.includes("event.key==='Enter'") && event.key === 'Enter') {
    if (action.includes('!event.shiftKey') && event.shiftKey) return;
    if (action.includes('event.preventDefault()')) event.preventDefault();
    if (action.includes('sendFoodMessage()')) sendFoodMessage();
    if (action.includes('addCustomWater()')) addCustomWater();
    if (action.includes('saveWaterGoal()')) saveWaterGoal();
  }
  if (action.includes("event.key==='Escape'") && event.key === 'Escape' && action.includes('cancelEditWaterGoal()')) {
    cancelEditWaterGoal();
  }
});

function enhanceActions(root = document) {
  root.querySelectorAll('[data-action]').forEach(element => {
    if (element.matches('button, a, input, select, textarea')) return;
    element.setAttribute('role', 'button');
    if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
    if (!element.hasAttribute('aria-label')) {
      const label = element.getAttribute('title') || element.textContent.trim().replace(/\s+/g, ' ');
      if (label) element.setAttribute('aria-label', label.slice(0, 120));
    }
  });
}

enhanceActions();
new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
  if (node.nodeType === Node.ELEMENT_NODE) enhanceActions(node);
}))).observe(document.body, { childList: true, subtree: true });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(error => {
    console.warn('Offline support registration failed:', error);
  }));
}

// Start only after every module-level constant, action and listener above has
// been initialized. Calling init earlier can trigger temporal-dead-zone errors
// from dashboard renderers and prevent all UI actions from being registered.
init();
