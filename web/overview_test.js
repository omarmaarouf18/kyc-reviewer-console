// Overview page tests: GET /api/overview cards render counts via
// textContent, "unavailable" figures degrade visibly, hostile strings from
// the API never become markup. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'ov-token';

// Live session storage so the default-route overview load runs.
function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

const OVERVIEW = {
  pending_kyb_kye: 14,
  pending_payment_subscriptions: 3,
  open_tickets: 5,
  assigned_tickets: 2,
  gps_disputes: 2,
  stuck_cod_jobs: 1,
  jobs_today: { pending_dispatch: 5, active: 12, completed: 45, cancelled: 2 },
  new_accounts_today: 18,
  new_accounts_7d: 114,
  suspended_accounts: 'unavailable',
};

test('overview cards render every figure from the API payload', async () => {
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/overview') ? jsonResponse(OVERVIEW) : jsonResponse([])),
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadOverview();

  for (const [key, want] of [
    ['pending_kyb_kye', '14'],
    ['pending_payment_subscriptions', '3'],
    ['open_tickets', '5'],
    ['assigned_tickets', '2'],
    ['gps_disputes', '2'],
    ['stuck_cod_jobs', '1'],
    ['new_accounts_today', '18'],
    ['new_accounts_7d', '114'],
    ['suspended_accounts', 'unavailable'],
  ]) {
    const card = env.doc.querySelector(`[data-testid="overview-${key}"]`);
    assert.ok(card, `missing stat card for ${key}`);
    const value = card.querySelector('strong').textContent;
    assert.equal(value, want, `${key} shows ${value}`);
  }

  const jobs = env.doc.querySelector('[data-testid="overview-jobs_today"]');
  assert.ok(jobs, 'jobs card exists');
  assert.match(jobs.textContent, /Pending dispatch/);
  assert.match(jobs.textContent, /45/);
  assert.doesNotMatch(jobs.textContent, /undefined|\$|EGP/, 'no invented units on counts');
});

test('unavailable figures are marked unavailable, never rendered as 0', async () => {
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ ...OVERVIEW, suspended_accounts: 'unavailable', open_tickets: 'unavailable' })
      : jsonResponse([])),
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadOverview();

  const suspended = env.doc.querySelector('[data-testid="overview-suspended_accounts"] strong');
  assert.match(suspended.className, /unavailable/);
  assert.doesNotMatch(suspended.textContent, /^0$/);
  assert.ok(env.doc.querySelector('[data-testid="overview-open_tickets"] strong').className.includes('unavailable'));
});

test('overview figures render API strings as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ ...OVERVIEW, suspended_accounts: XSS, new_accounts_today: XSS })
      : jsonResponse([])),
  });
  await env.ctx.loadOverview();

  assert.deepEqual(hostileNodes(env.doc), []);
  assert.ok(env.doc.querySelector('[data-testid="overview-suspended_accounts"]').textContent.includes(XSS));
  assert.ok(env.doc.querySelector('[data-testid="overview-new_accounts_today"]').textContent.includes(XSS));
});

test('overview refresh button re-fetches and replaces the grid', async () => {
  let calls = 0;
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => {
      if (!url.startsWith('/api/overview')) return jsonResponse([]);
      calls += 1;
      return jsonResponse({ ...OVERVIEW, open_tickets: calls * 10 });
    },
  });
  // The page bootstrap already loaded the overview (default route): let it
  // settle, then count only the calls this test triggers.
  await new Promise((resolve) => setImmediate(resolve));
  calls = 0;
  await env.ctx.loadOverview();
  assert.equal(calls, 1);
  assert.equal(env.doc.querySelector('[data-testid="overview-open_tickets"] strong').textContent, '10');

  env.doc.getElementById('refresh-overview-btn').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(env.doc.querySelector('[data-testid="overview-open_tickets"] strong').textContent, '20');
});

test('a non-object overview payload renders an empty state without crashing', async () => {
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/overview') ? jsonResponse([]) : jsonResponse([])),
  });
  await env.ctx.loadOverview();

  assert.match(env.doc.getElementById('overview-grid').textContent, /No overview data/);
  assert.deepEqual(hostileNodes(env.doc), []);
});
