// Shell shell i18n + theme tests: language toggle drives RTL/LTR and nav
// labels, theme toggle flips the design-token palette. Runs the real ES
// modules against index.html (see testdom.js).
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse } = require('./testdom.js');

test('language toggle switches nav labels between Arabic (RTL) and English (LTR)', async () => {
  const env = await loadApp();
  env.ctx._resetLanguage('ar');
  await env.main.initShell();

  assert.equal(env.doc.documentElement.dir, 'rtl');
  assert.equal(env.doc.documentElement.lang, 'ar');
  assert.match(env.doc.getElementById('tab-queue-btn').textContent, /قيد المراجعة/);
  assert.match(env.doc.getElementById('tab-payouts-btn').textContent, /طلبات الصرف/);
  assert.equal(env.doc.getElementById('logout-btn').textContent, 'تسجيل الخروج');

  env.doc.getElementById('lang-toggle-btn').click();
  assert.equal(env.doc.documentElement.dir, 'ltr');
  assert.equal(env.doc.documentElement.lang, 'en');
  assert.match(env.doc.getElementById('tab-queue-btn').textContent, /Pending Submissions/);
  assert.match(env.doc.getElementById('tab-payouts-btn').textContent, /Payout Requests/);
  assert.equal(env.doc.getElementById('logout-btn').textContent, 'Sign out');

  // The badge survives the translation pass (textContent never overwrites it).
  assert.equal(env.doc.getElementById('queue-badge').textContent, '0');

  env.doc.getElementById('lang-toggle-btn').click();
  assert.equal(env.doc.documentElement.dir, 'rtl');
});

test('the language toggle re-renders the open page in the new language', async () => {
  const env = await loadApp({
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ pending_kyb_kye: 14, stuck_cod_jobs: 0, jobs_today: {} })
      : jsonResponse([])),
  });
  env.ctx._resetLanguage('ar');
  await env.main.initShell();
  await env.ctx.loadOverview();

  const grid = env.doc.getElementById('overview-grid');
  assert.match(grid.textContent, /مراجعات KYB\/KYE/);

  // The page content is rendered by the page modules, not by the shell
  // translation pass: the toggle has to re-render the open route.
  env.doc.getElementById('lang-toggle-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(env.doc.documentElement.lang, 'en');
  assert.match(grid.textContent, /Pending KYB\/KYE/);
  assert.doesNotMatch(grid.textContent, /مراجعات KYB\/KYE/);
});

test('theme toggle flips the design-token palette on html[data-theme]', async () => {
  const env = await loadApp();
  env.ctx.applyTheme('light');
  await env.main.initShell();

  assert.equal(env.doc.documentElement.dataset.theme, 'light');
  assert.equal(env.doc.getElementById('theme-toggle-btn').textContent, '☾');

  env.doc.getElementById('theme-toggle-btn').click();
  assert.equal(env.doc.documentElement.dataset.theme, 'dark');
  assert.equal(env.doc.getElementById('theme-toggle-btn').textContent, '☀');

  env.doc.getElementById('theme-toggle-btn').click();
  assert.equal(env.doc.documentElement.dataset.theme, 'light');
  assert.equal(env.doc.getElementById('theme-toggle-btn').textContent, '☾');
});

test('invalid reviewer token message is localized', async () => {
  const env = await loadApp({
    fetch: async () => ({ status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) }),
  });
  env.ctx._resetLanguage('ar');
  await env.main.initShell();
  env.doc.getElementById('token').value = 'bad-token';
  env.doc.getElementById('login-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const errEl = env.doc.getElementById('login-error');
  assert.equal(errEl.hidden, false);
  assert.equal(errEl.textContent, 'رمز المراجع غير صالح.');
});
