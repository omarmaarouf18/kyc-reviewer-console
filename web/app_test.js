// Unit tests for the console API client and mutation pages, run against the
// real ES modules (moved from the app.js copy tests in CONSOLE-V2 item 1:
// every function under test here is the real implementation).
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse } = require('./testdom.js');

const TOKEN = 'test-token';

// Token plus fresh activity = a live session for bootstrapSession() to keep.
function signedInStorage(token = TOKEN) {
  return new Map([[TOKEN_KEY, token], ['reviewer_last_activity', String(Date.now())]]);
}

test('api() calls logout and throws on HTTP 401', async () => {
  const env = await loadApp({
    storage: signedInStorage(),
    fetch: async () => jsonResponse({ error: 'unauthorized' }, 401),
  });
  env.store.set(TOKEN_KEY, TOKEN);

  await assert.rejects(
    async () => { await env.ctx.api('/api/tickets/resolve'); },
    { message: 'unauthorized' }
  );

  assert.equal(env.store.size, 0, 'token and every storage key cleared');
  assert.match(env.doc.getElementById('login-error').textContent, /invalid token/i);
});

test('api() does NOT call logout on HTTP 503 Service Unavailable and returns response', async () => {
  const env = await loadApp({
    storage: signedInStorage(),
    fetch: async () => jsonResponse({
      error: 'service_unavailable',
      message: 'Authentication service is temporarily unavailable. Please try again later.',
    }, 503),
  });

  const res = await env.ctx.api('/api/tickets/resolve');
  assert.equal(res.status, 503);
  assert.equal(res.ok, false);
  assert.equal(env.store.get(TOKEN_KEY), TOKEN);

  const data = await res.json();
  assert.equal(data.error, 'service_unavailable');
});

test('submitResolveTicket() catches 503 and surfaces in-app error without crashing or logging out', async () => {
  const env = await loadApp({
    storage: signedInStorage(),
    fetch: async () => jsonResponse({
      error: 'service_unavailable',
      message: 'Authentication service is temporarily unavailable. Please try again later.',
    }, 503),
  });
  // The console is Arabic by default; these assertions read the English
  // labels, so the language is pinned explicitly.
  env.ctx.setLanguage('en');
  env.ctx.openResolveTicketDialog({ ticket_id: 'tkt-12345', customer_id: 'c1', created_at: new Date().toISOString() });
  document.getElementById('resolve-ticket-note').value = 'Investigated customer issue';

  await env.ctx.submitResolveTicket();

  const errorEl = env.doc.getElementById('resolve-ticket-error');
  const submitBtn = env.doc.getElementById('resolve-ticket-submit');
  const dialogEl = env.doc.getElementById('resolve-ticket-dialog');
  assert.equal(env.store.get(TOKEN_KEY), TOKEN);
  assert.equal(dialogEl.open, true, 'Dialog remains open for retry');
  assert.equal(submitBtn.disabled, false);
  assert.equal(submitBtn.textContent, 'Confirm Resolve');
  assert.equal(errorEl.textContent, 'Authentication service is temporarily unavailable. Please try again later.');
  assert.equal(errorEl.hidden, false);
});

test('submitResolveTicket() catches 401 gracefully without unhandled promise rejection crash', async () => {
  let armed = false;
  const env = await loadApp({
    storage: signedInStorage(),
    fetch: async () => (armed ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse([])),
  });
  await new Promise((resolve) => setImmediate(resolve));
  env.ctx.setLanguage('en');
  env.ctx.openResolveTicketDialog({ ticket_id: 'tkt-123', customer_id: 'c1', created_at: new Date().toISOString() });
  document.getElementById('resolve-ticket-note').value = 'Note';
  armed = true;

  // No unhandled rejection: the call resolves with the session signed out.
  await env.ctx.submitResolveTicket();

  assert.equal(env.store.size, 0);
  const submitBtn = env.doc.getElementById('resolve-ticket-submit');
  assert.equal(submitBtn.disabled, false);
  assert.equal(submitBtn.textContent, 'Confirm Resolve');
});

test('formatBytes formats various file sizes correctly', async () => {
  const env = await loadApp();
  const { formatBytes } = env.ctx;

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1 MB');
  assert.equal(formatBytes(5242880), '5 MB');
});

test('retrieveUserDocs validates mandatory reason before calling API', async () => {
  let apiCalls = 0;
  const env = await loadApp({
    storage: new Map([[TOKEN_KEY, TOKEN]]),
    fetch: async () => { apiCalls += 1; return jsonResponse({}); },
  });

  await env.ctx.retrieveUserDocs({ id: 'u1' }, '   ');
  assert.equal(apiCalls, 0);
  assert.match(env.doc.getElementById('user-docs-reason-error').textContent, /mandatory/i);

  await env.ctx.retrieveUserDocs({ id: 'u1' }, 'x'.repeat(1001));
  assert.equal(apiCalls, 0);
  assert.match(env.doc.getElementById('user-docs-reason-error').textContent, /1000/);

  await env.ctx.retrieveUserDocs({ id: 'u1' }, 'compliance audit');
  assert.equal(apiCalls, 1);
});

test('sendTicketAttachment attaches X-Reviewer-Token and sends multipart FormData', async () => {
  let sentHeaders = {};
  let sentUrl = '';

  const env = await loadApp({
    storage: signedInStorage('rev-tok-999'),
    fetch: async (url, options) => {
      sentUrl = url;
      sentHeaders = options.headers;
      if (url.startsWith('/api/queue')) return jsonResponse([]);
      return jsonResponse({ status: 'success', attachment_url: 'https://test/attachment' });
    },
  });

  const res = await env.ctx.sendTicketAttachment('tkt-456', new Blob(['x']), 'Screenshot');
  assert.equal(sentUrl, '/api/tickets/attachment?ticket_id=tkt-456');
  assert.equal(sentHeaders['X-Reviewer-Token'], 'rev-tok-999');
  assert.equal(res.status, 'success');
});

const TOKEN_KEY = 'reviewer_token';
