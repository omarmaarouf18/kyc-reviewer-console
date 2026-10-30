// KYC queue side panel + keyboard shortcut tests: picking a row opens the
// review panel, the panel renders API values as text, the approve/reject
// shortcuts post the right decision and a rejection without a reason never
// reaches the API. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'kyc-token';

const SUB = {
  user_id: 'u-1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'owner',
  document_errors: [],
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

// A queue page with two submissions and a recording fetch stub.
async function queueEnv({ reviews = [] } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/queue')) {
        return jsonResponse([SUB, { ...SUB, user_id: 'u-2', username: 'bob', email: 'bob@example.com', role: 'employee' }]);
      }
      if (url.startsWith('/api/review')) {
        reviews.push(JSON.parse(options.body));
        return jsonResponse({ status: 'success' });
      }
      return jsonResponse([]);
    },
  });
  // The console is Arabic by default; these assertions read the English
  // strings, so the language is pinned explicitly.
  env.ctx.setLanguage('en');
  // The queue page is the visible page while these shortcuts are exercised
  // (the router shows it on navigation).
  env.doc.getElementById('queue-section').hidden = false;
  await env.ctx.loadQueue();
  return { env, calls, reviews };
}

test('clicking a queue row opens the side panel with the submission details', async () => {
  const { env } = await queueEnv();
  const row = env.doc.querySelectorAll('#queue-table tbody tr')[1];
  row.click();

  const panel = env.doc.getElementById('kyc-panel');
  assert.equal(panel.hidden, false);
  const details = env.doc.getElementById('kyc-panel-details').textContent;
  assert.match(details, /bob/);
  assert.match(details, /bob@example\.com/);
  assert.match(details, /u-2/);
  assert.equal(env.doc.querySelectorAll('#queue-table tbody tr')[1].className.includes('selected'), true);
});

test('the panel renders API values as text (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/queue')
      ? jsonResponse([{ ...SUB, username: XSS, email: XSS, user_id: XSS, document_errors: [XSS] }])
      : jsonResponse([])),
  });
  env.doc.getElementById('queue-section').hidden = false;
  await env.ctx.loadQueue();
  env.doc.querySelectorAll('#queue-table tbody tr')[0].click();

  assert.deepEqual(hostileNodes(env.doc), []);
  const details = env.doc.getElementById('kyc-panel-details').textContent;
  assert.ok(details.includes(XSS), 'panel shows the payload as text');
  assert.ok(env.doc.getElementById('kyc-panel-docs-error').textContent.includes(XSS));
});

test('the "a" shortcut approves the selected submission', async () => {
  const { env, reviews } = await queueEnv();
  env.doc.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  env.doc.dispatchEvent({ type: 'keydown', key: 'a' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].action, 'approve');
  assert.equal(reviews[0].user_id, 'u-1');
});

test('the "r" shortcut selects rejection and a rejection without a reason never reaches the API', async () => {
  const { env, reviews } = await queueEnv();
  env.doc.dispatchEvent({ type: 'keydown', key: 'r' });

  const reject = env.doc.querySelector('input[name="kyc-panel-action"][value="reject"]');
  assert.equal(reject.checked, true);
  assert.equal(env.doc.getElementById('kyc-panel-reason').required, true);

  env.doc.getElementById('kyc-panel-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reviews.length, 0, 'no API call without a reason');
  assert.equal(env.doc.getElementById('kyc-panel-error').hidden, false);
  assert.match(env.doc.getElementById('kyc-panel-error').textContent, /reason/i);

  // With a reason the rejection is submitted.
  env.doc.getElementById('kyc-panel-reason').value = 'documents unreadable';
  env.doc.getElementById('kyc-panel-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].action, 'reject');
  assert.equal(reviews[0].reason, 'documents unreadable');
});

test('arrow keys move the selection and Escape closes the panel', async () => {
  const { env } = await queueEnv();
  env.doc.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(env.ctx.state.queueState.selectedIndex, 0);
  env.doc.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(env.ctx.state.queueState.selectedIndex, 1);
  env.doc.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.equal(env.ctx.state.queueState.selectedIndex, 0);

  env.doc.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(env.doc.getElementById('kyc-panel').hidden, false);

  env.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(env.doc.getElementById('kyc-panel').hidden, true);
});

test('shortcuts never hijack typing in the reason field', async () => {
  const { env, reviews } = await queueEnv();
  const reason = env.doc.getElementById('kyc-panel-reason');
  env.doc.getElementById('kyc-panel-reason').value = '';
  reason.dispatchEvent({ type: 'keydown', key: 'a', target: { tagName: 'TEXTAREA' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reviews.length, 0);
});
