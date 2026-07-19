import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, css, manifestText, sw] = await Promise.all([
  readFile('index.html', 'utf8'), readFile('src/app.js', 'utf8'), readFile('src/styles.css', 'utf8'),
  readFile('public/manifest.webmanifest', 'utf8'), readFile('public/sw.js', 'utf8')
]);
const manifest = JSON.parse(manifestText);

assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
assert.match(html, /worker-src 'self'/);
assert.match(html, /class="skip-link" href="#main-content"/);
assert.match(html, /id="main-content" tabindex="-1"/);
assert.match(html, /id="toast"[^>]+role="status"[^>]+aria-live="polite"/);
assert.match(html, /id="theme-toggle"[^>]+data-action="toggleTheme\(\)"/);
assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.length > 0);
assert.match(css, /:focus-visible/);
assert.match(css, /data-theme="light"/);
assert.match(app, /function toggleTheme\(/);
assert.match(app, /function enhanceActions\(/);
assert.match(app, /navigator\.serviceWorker\.register\(`\$\{import\.meta\.env\.BASE_URL\}sw\.js`\)/);
const initCall = app.lastIndexOf('\ninit();');
const actionListener = app.lastIndexOf("document.addEventListener('click'");
const waterConstant = app.indexOf('const WATER_GOAL_DEFAULT');
assert.ok(initCall > actionListener, 'application must initialize after UI event listeners');
assert.ok(initCall > waterConstant, 'application must initialize after dashboard constants');
assert.match(sw, /caches\.open/);
assert.match(sw, /addEventListener\('fetch'/);
assert.match(sw, /const BASE = new URL\('\.\/'/);

console.log('PASS PWA, theme and accessibility experience tests');
