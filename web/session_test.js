// Session hygiene tests against the real ES modules: idle sign-out, 401
// handling, Sign out wiping state, and the chat socket keeping the token out
// of URLs.
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse } = require('./testdom.js');

const TOKEN = 'rev-test-token';

// A signed-in page load: token plus fresh activity so bootstrapSession keeps
// the session (see session.js checkIdle).
function signedIn(fetch) {
  const storage = new Map([['reviewer_token', TOKEN], ['reviewer_last_activity', String(Date.now())]]);
  return loadApp({ fetch, storage });
}

test('idle timeout is 30 minutes', async () => {
  const env = await loadApp();
  assert.equal(env.ctx.IDLE_TIMEOUT_MS, 30 * 60 * 1000);
});

test('checkIdle signs out after the idle timeout and not before', async () => {
  const env = await signedIn(async () => jsonResponse([]));
  const now = Date.now();
  assert.equal(env.ctx.checkIdle(now + 29 * 60 * 1000), false);
  assert.equal(env.store.get('reviewer_token'), TOKEN);

  assert.equal(env.ctx.checkIdle(now + 30 * 60 * 1000 + 1), true);
  assert.equal(env.store.size, 0);
  assert.equal(env.doc.getElementById('app-view').hidden, true);
  assert.equal(env.doc.getElementById('login-view').hidden, false);
  assert.match(env.doc.getElementById('login-error').textContent, /inactivity/);
});

test('user activity resets the idle clock', async () => {
  const env = await signedIn(async () => jsonResponse([]));
  env.store.set('reviewer_last_activity', '0');
  for (const fn of env.winListeners.keydown) fn({ type: 'keydown' });
  assert.equal(env.ctx.checkIdle(), false);
  assert.equal(env.store.get('reviewer_token'), TOKEN);
});

test('a stale session is signed out on page load', async () => {
  const storage = new Map([['reviewer_token', TOKEN], ['reviewer_last_activity', String(Date.now() - 31 * 60 * 1000)]]);
  const env = await loadApp({ fetch: async () => jsonResponse([]), storage });
  assert.equal(env.store.size, 0);
  assert.equal(env.doc.getElementById('app-view').hidden, true);
});

test('a 401 from any call clears the session', async () => {
  for (const call of [
    (ctx) => ctx.loadPayouts(),
    (ctx) => ctx.loadAccounts(),
    (ctx) => ctx.refreshBadgeCounts(),
    (ctx) => ctx.sendTicketAttachment('t1', new Blob(['x']), 'hi').catch(() => {}),
  ]) {
    // Armed only after the page bootstrap's own calls have settled, so the
    // 401 is attributable to the call under test.
    let armed = false;
    const env = await signedIn(async () => (armed ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse([])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.store.get('reviewer_token'), TOKEN);
    armed = true;
    await call(env.ctx);
    assert.equal(env.store.get('reviewer_token'), undefined, String(call));
    assert.equal(env.doc.getElementById('app-view').hidden, true, String(call));
  }
});

test('sign out wipes sessionStorage, rendered data and in-memory state', async () => {
  const env = await signedIn(async (url) => {
    if (url.startsWith('/api/accounts')) return jsonResponse({ accounts: [{ id: 'u1', username: 'alice', email: 'a@x', role: 'owner', is_active: true }], total: 1 });
    if (url.startsWith('/api/tickets/history')) return jsonResponse([{ sender_username: 'bob', content: 'my address is 1 Nile St' }]);
    return jsonResponse([]);
  });
  env.store.set('some_other_key', 'x');
  await env.ctx.loadAccounts();
  await env.ctx.openTicketChat({ ticket_id: 'tkt-1', customer_id: 'c1', status: 'assigned' });
  env.ctx.openSuspendDialog({ id: 'u1', username: 'alice', email: 'a@x', role: 'owner' });
  env.doc.getElementById('suspend-reason').value = 'draft reason';
  assert.match(env.doc.getElementById('accounts-table').textContent, /alice/);

  env.doc.getElementById('logout-btn').click();

  assert.equal(env.store.size, 0);
  assert.doesNotMatch(env.doc.getElementById('accounts-table').textContent, /alice/);
  assert.equal(env.doc.getElementById('ticket-chat-messages').textContent, '');
  assert.equal(env.doc.getElementById('suspend-dialog').open, false);
  assert.equal(env.doc.getElementById('suspend-reason').value, '');
  assert.equal(env.sockets[0].readyState, 3, 'chat socket closed');
  const state = env.ctx.state;
  assert.equal(state.activeChatWs === null && state.activeChatTicket === null && state.targetAccount === null && state.currentReviewer === null, true);
});

test('chat socket carries the token as a subprotocol, never in the URL', async () => {
  const env = await signedIn(async () => jsonResponse([]));
  await env.ctx.openTicketChat({ ticket_id: 'tkt-1', customer_id: 'c1', status: 'assigned' });
  const ws = env.sockets[0];
  assert.equal(ws.url, 'ws://console.test/api/chat/ws');
  assert.doesNotMatch(ws.url, /token|rev-test/);
  assert.deepEqual([...ws.protocols], ['kyc-console-auth', TOKEN]);
});

test('sign-in clears the token field', async () => {
  const env = await loadApp({ fetch: async () => jsonResponse([]) });
  env.doc.getElementById('token').value = TOKEN;
  await new Promise((resolve) => {
    env.doc.getElementById('login-form').dispatchEvent({ type: 'submit', preventDefault() {} });
    setImmediate(resolve);
  });
  assert.equal(env.doc.getElementById('token').value, '');
  assert.equal(env.store.get('reviewer_token'), TOKEN);
});
