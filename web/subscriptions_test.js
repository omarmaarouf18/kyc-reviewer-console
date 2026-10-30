// Subscriptions queue-first tests: the pending upgrade queue is the default
// view, its rows carry the tenant / plan / request date / owner contact, the
// activation posts the queue contract and the second view lists every
// subscription. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'subs-token';

const QUEUE_ITEM = {
  id: 'sub-771',
  subscription_id: 'sub-771',
  tenant_id: 'tenant-cairo-express',
  tenant_name: 'Cairo Express Logistics',
  requested_plan: 'pro',
  requested_at: '2026-10-28T14:30:00Z',
  owner_contact: {
    username: 'mkamel',
    name: 'Moustafa Kamel',
    company_name: 'Cairo Express Logistics',
    email: 'moustafa@cairoexpress.com',
    phone: '+201001122334',
  },
  tier: 'pro',
  status: 'pending_payment',
  started_at: '2026-10-28T14:30:00Z',
};

const SUBSCRIPTION = {
  id: 'sub-500',
  tenant_id: 'tenant-giza',
  tier: 'paid',
  started_at: '2026-09-01T00:00:00Z',
  expires_at: '2026-12-01T00:00:00Z',
  activated_by: 'rev-sarah-1',
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

async function subsEnv({ queue = [QUEUE_ITEM], subscriptions = [SUBSCRIPTION] } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/subscriptions/queue')) {
        return jsonResponse({ queue, subscriptions: queue, total: queue.length, page: 1, limit: 15 });
      }
      if (url.startsWith('/api/subscriptions?')) {
        return jsonResponse({ subscriptions, total: subscriptions.length, page: 1, limit: 15 });
      }
      return jsonResponse({ success: true });
    },
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadSubscriptionQueue();
  return { env, calls };
}

test('the upgrade queue is the default view and the badge counts it', async () => {
  const { env } = await subsEnv();
  assert.equal(env.doc.getElementById('subscriptions-queue-view').hidden, false);
  assert.equal(env.doc.getElementById('subscriptions-all-view').hidden, true);
  assert.equal(env.doc.getElementById('subscriptions-badge').textContent, '1');
});

test('a queue row shows the tenant, requested plan, request date and owner contact', async () => {
  const { env } = await subsEnv();
  const text = env.doc.getElementById('subscriptions-queue-table').textContent;
  assert.match(text, /Cairo Express Logistics/);
  assert.match(text, /tenant-cairo-express/);
  assert.match(text, /PRO/);
  assert.match(text, /Moustafa Kamel/);
  assert.match(text, /@mkamel/);
  assert.match(text, /moustafa@cairoexpress\.com/);
  assert.match(text, /\+201001122334/);
});

test('activating a queue item posts the queue contract (tenant_id, subscription_id, duration_days)', async () => {
  const { env, calls } = await subsEnv();
  env.doc.querySelectorAll('#subscriptions-queue-table tbody tr')[0].querySelector('button').click();
  assert.equal(env.doc.getElementById('activate-sub-dialog').open, true);

  env.doc.getElementById('activate-sub-duration').value = '90';
  env.doc.getElementById('activate-sub-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'activation request was sent');
  assert.match(post.url, /\/api\/subscriptions\/activate$/);
  assert.equal(post.body.tenant_id, 'tenant-cairo-express');
  assert.equal(post.body.subscription_id, 'sub-771');
  assert.equal(post.body.duration_days, 90);
});

test('the queue uses the subscription_id field, not the queue row id', async () => {
  const { env, calls } = await subsEnv({
    queue: [{ ...QUEUE_ITEM, id: 'queue-row-1', subscription_id: 'sub-real-9' }],
  });
  env.doc.querySelectorAll('#subscriptions-queue-table tbody tr')[0].querySelector('button').click();
  env.doc.getElementById('activate-sub-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.subscription_id, 'sub-real-9');
});

test('switching to the all-subscriptions view loads the full list', async () => {
  const { env, calls } = await subsEnv();
  env.doc.getElementById('subscriptions-view-all').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(env.doc.getElementById('subscriptions-all-view').hidden, false);
  assert.equal(env.doc.getElementById('subscriptions-queue-view').hidden, true);
  const text = env.doc.getElementById('subscriptions-table').textContent;
  assert.match(text, /tenant-giza/);
  assert.match(text, /PAID/);
  assert.match(text, /rev-sarah-1/);
  assert.ok(calls.some((c) => c.url.startsWith('/api/subscriptions?')));
});

test('queue rows render API values as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const { env } = await subsEnv({
    queue: [{
      ...QUEUE_ITEM,
      tenant_name: XSS,
      tenant_id: XSS,
      owner_contact: { name: XSS, username: XSS, email: XSS, phone: XSS },
    }],
  });
  const text = env.doc.getElementById('subscriptions-queue-table').textContent;
  assert.ok(text.includes(XSS), 'the payload is shown as text');
  assert.deepEqual(hostileNodes(env.doc), []);
});

test('an empty queue renders an explicit empty state', async () => {
  const { env } = await subsEnv({ queue: [] });
  const text = env.doc.getElementById('subscriptions-queue-table').textContent;
  assert.match(text, /No upgrade requests awaiting verification\./);
});
