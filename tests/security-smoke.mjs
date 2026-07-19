import assert from 'node:assert/strict';
import fs from 'node:fs';
import { escapeHtml } from '../src/utils/security.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inlineScript = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

const attacks = [
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "'><script>alert(1)</script>",
  'javascript:alert(1)&x=<b>'
];

for (const attack of attacks) {
  const escaped = escapeHtml(attack);
  assert.equal(/[<>]/.test(escaped), false, `dangerous tag survived: ${attack}`);
}

assert.doesNotMatch(inlineScript, /div\.innerHTML\s*=\s*`<div class="msg-bubble">/,
  'chat messages must not be rendered with innerHTML');
assert.match(inlineScript, /bubble\.textContent\s*=/,
  'chat messages must use textContent');
assert.match(inlineScript, /escapeHtml\(advice\)/,
  'AI advice must be escaped');
assert.match(inlineScript, /escapeHtml\(f\.name\)/,
  'food names must be escaped');
assert.match(inlineScript, /el\.textContent\s*=\s*`\$\{icons/,
  'toast messages must use textContent');

assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i,
  'inline script blocks are forbidden');
assert.doesNotMatch(html, /\son[a-z]+=/i,
  'inline event handlers are forbidden');
assert.match(html, /script-src-attr 'none'/,
  'CSP must disable inline event attributes');
assert.match(html, /object-src 'none'/,
  'CSP must disable plugins');
assert.doesNotMatch(inlineScript, /\beval\s*\(/,
  'eval is forbidden');
assert.doesNotMatch(inlineScript, /AIza[0-9A-Za-z_-]{20,}/,
  'Firebase project configuration must not be hard-coded');

const actionMapSource = inlineScript.match(/const UI_ACTIONS = \{([\s\S]*?)\n\};/)?.[1] || '';
for (const match of html.matchAll(/data-(?:action|change-action)="([^"]+)"/g)) {
  const expression = match[1];
  if (expression.startsWith('window.open(')) continue;
  for (const call of expression.matchAll(/(?:^|\)|;)([A-Za-z][A-Za-z0-9_]*)\(/g)) {
    if (call[1] === 'if') continue;
    assert.match(actionMapSource, new RegExp(`\\b${call[1]}\\b`),
      `declarative action is not allow-listed: ${call[1]}`);
  }
}

console.log('PASS security smoke tests');
