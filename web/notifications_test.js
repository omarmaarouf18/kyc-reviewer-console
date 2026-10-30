// Admin announcement tests (item 11): the composer builds the
// notification-service contract, the dry run resolves the audience size, the
// broadcast confirmation is handled and the send history is rendered.
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'notify-token';

const SEND = {
  id: 'send-1793255745373574323',
  created_at: '2026-10-29T09:35:45Z',
  reviewer_id: 'rev-sarah-1',
  reason: 'Emergency platform maintenance notification',
  audience: { kind: 'role', role: 'customers' },
  audience_size: 450,
  status: 'done',
  sent_count: 450,
  failed_count: 0,
  deep_link: '/plan',
  title_en: 'Scheduled System Maintenance',
  title_ar: 'صيانة مجدولة للنظام',
  body_en: 'Maintenance tonight at 2:00 AM.',
  body_ar: 'صيانة الليلة.',
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

// notifEnv builds an environment whose notification endpoints are stubbed.
async function notifEnv({ send = SEND, sends = [SEND], sendResponse, listResponse } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/notifications/sends/')) return jsonResponse(send);
      if (url.startsWith('/api/notifications/sends')) {
        if (listResponse) return listResponse;
        return jsonResponse({ sends, total: sends.length, page: 1, limit: 20 });
      }
      if (url.startsWith('/api/notifications/send')) {
        if (sendResponse) return sendResponse;
        return jsonResponse({ job_id: 'send-1', status: 'queued', audience_size: 450 }, 202);
      }
      return jsonResponse([]);
    },
  });
  env.ctx.setLanguage('en');
  return { env, calls };
}

// fillComposer fills the announcement form with a valid role announcement.
function fillComposer(env, { kind = 'role' } = {}) {
  env.doc.getElementById('notif-audience-kind').value = kind;
  env.ctx.updateAudienceFields();
  if (kind === 'role') env.doc.getElementById('notif-audience-role').value = 'customers';
  if (kind === 'tenant') env.doc.getElementById('notif-audience-tenant-id').value = 'tenant-55';
  if (kind === 'user') env.doc.getElementById('notif-audience-user-id').value = 'user-9';
  env.doc.getElementById('notif-title-ar').value = 'صيانة مجدولة';
  env.doc.getElementById('notif-title-en').value = 'Scheduled Maintenance';
  env.doc.getElementById('notif-body-ar').value = 'صيانة الليلة.';
  env.doc.getElementById('notif-body-en').value = 'Maintenance tonight.';
  env.doc.getElementById('notif-reason').value = 'Emergency platform maintenance notification';
}

test('the send history renders the sends with their status and counters', async () => {
  const { env } = await notifEnv();
  await env.ctx.loadNotifications();

  const text = env.doc.getElementById('notif-sends-table').textContent;
  assert.match(text, /send-1793255745373574323/);
  assert.match(text, /rev-sarah-1/);
  assert.match(text, /450/);
  assert.match(text, /\/plan/);
  assert.match(text, /Done/);
});

test('the composer posts the notification-service contract', async () => {
  const { env, calls } = await notifEnv();
  fillComposer(env);
  env.doc.getElementById('notif-deep-link').value = '/plan';
  env.doc.getElementById('notif-idempotency-key').value = 'announce-20261029-01';

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'the announcement was sent');
  assert.match(post.url, /\/api\/notifications\/send$/);
  assert.equal(post.body.reason, 'Emergency platform maintenance notification');
  assert.deepEqual(post.body.audience, { kind: 'role', role: 'customers' });
  assert.deepEqual(post.body.title, { ar: 'صيانة مجدولة', en: 'Scheduled Maintenance' });
  assert.deepEqual(post.body.body, { ar: 'صيانة الليلة.', en: 'Maintenance tonight.' });
  assert.equal(post.body.deep_link, '/plan');
  assert.equal(post.body.dry_run, false);
  assert.equal(post.body.idempotency_key, 'announce-20261029-01');
});

test('a missing reason or a missing translation blocks the send', async () => {
  const { env, calls } = await notifEnv();
  fillComposer(env);
  env.doc.getElementById('notif-reason').value = '';

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(env.doc.getElementById('notif-send-error').hidden, false);

  env.doc.getElementById('notif-reason').value = 'a reason';
  env.doc.getElementById('notif-title-en').value = '';
  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(env.doc.getElementById('notif-send-error').textContent, /Arabic and an English title/);
});

test('an external deep link is refused before the request is sent', async () => {
  const { env, calls } = await notifEnv();
  fillComposer(env);
  env.doc.getElementById('notif-deep-link').value = 'https://evil.example.com';

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(env.doc.getElementById('notif-send-error').textContent, /not an allowed in-app route/);
});

test('the dry run resolves the audience size without sending', async () => {
  const { env, calls } = await notifEnv({
    sendResponse: jsonResponse({ dry_run: true, audience_size: 450, audience: { kind: 'role', role: 'customers' } }),
  });
  fillComposer(env);

  env.doc.getElementById('notif-dry-run-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post);
  assert.equal(post.body.dry_run, true);
  assert.match(env.doc.getElementById('notif-send-result').textContent, /Resolved audience size: 450/);
});

test('a broadcast to everyone asks for the audience size and pre-fills it', async () => {
  const { env, calls } = await notifEnv({
    sendResponse: jsonResponse({
      error: 'confirmation_required',
      code: 'confirmation_required',
      message: 'confirmation required',
      resolved_audience_size: 4500,
    }, 400),
  });
  fillComposer(env, { kind: 'everyone' });

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.audience.kind, 'everyone');
  assert.equal(env.doc.getElementById('notif-confirm-size').value, '4500');
  assert.match(env.doc.getElementById('notif-send-error').textContent, /4500 users/);
});

test('a confirmed broadcast sends the confirmed audience size', async () => {
  const { env, calls } = await notifEnv();
  fillComposer(env, { kind: 'everyone' });
  env.doc.getElementById('notif-confirm-size').value = '4500';

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.confirm_audience_size, 4500);
});

test('the rate limit is reported without ending the session', async () => {
  const { env } = await notifEnv({
    sendResponse: jsonResponse({ error: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'rate limit exceeded' }, 429),
  });
  fillComposer(env);

  env.doc.getElementById('notif-send-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(env.doc.getElementById('notif-send-error').textContent, /rate limit/i);
  assert.equal(env.store.get(TOKEN_KEY), TOKEN);
});

test('the send details dialog shows the delivery counters of one job', async () => {
  const { env } = await notifEnv();
  await env.ctx.loadNotifications();
  env.doc.querySelectorAll('#notif-sends-table tbody tr')[0].querySelector('button').click();
  await new Promise((resolve) => setImmediate(resolve));

  const details = env.doc.getElementById('notification-send-details').textContent;
  assert.match(details, /send-1793255745373574323/);
  assert.match(details, /rev-sarah-1/);
  assert.match(details, /Scheduled System Maintenance/);
});

test('the notification rows render API values as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const { env } = await notifEnv({
    sends: [{ ...SEND, id: XSS, reviewer_id: XSS, reason: XSS, deep_link: XSS }],
  });
  await env.ctx.loadNotifications();

  assert.ok(env.doc.getElementById('notif-sends-table').textContent.includes(XSS));
  assert.deepEqual(hostileNodes(env.doc), []);
});

test('the audience selector shows only the fields the kind needs', async () => {
  const { env } = await notifEnv();
  const kind = env.doc.getElementById('notif-audience-kind');

  kind.value = 'user';
  env.ctx.updateAudienceFields();
  assert.equal(env.doc.getElementById('notif-audience-user-fields').hidden, false);
  assert.equal(env.doc.getElementById('notif-audience-role-fields').hidden, true);
  assert.equal(env.doc.getElementById('notif-audience-tenant-fields').hidden, true);

  kind.value = 'role';
  env.ctx.updateAudienceFields();
  assert.equal(env.doc.getElementById('notif-audience-user-fields').hidden, true);
  assert.equal(env.doc.getElementById('notif-audience-role-fields').hidden, false);
});
