// Accounts drawer tests: clicking an account row opens the detail drawer,
// the drawer renders API values as text and offers the action that matches
// the account's standing. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'acc-token';

const ACCOUNT = {
  id: 'u-1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'owner',
  kyc_status: 'approved',
  account_status: 'active',
  is_active: true,
  created_at: '2026-10-01T10:00:00Z',
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

async function accountsEnv(accounts = [ACCOUNT]) {
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/accounts')
      ? jsonResponse({ accounts, total: accounts.length })
      : jsonResponse([])),
  });
  // The console is Arabic by default; these assertions read the English
  // labels, so the language is pinned explicitly.
  env.ctx.setLanguage('en');
  await env.ctx.loadAccounts();
  return env;
}

test('clicking an account row opens the drawer with its details', async () => {
  const env = await accountsEnv();
  env.doc.querySelectorAll('#accounts-table tbody tr')[0].click();

  const drawer = env.doc.getElementById('account-drawer');
  assert.equal(drawer.hidden, false);
  assert.equal(env.doc.getElementById('account-drawer-backdrop').hidden, false);

  const details = env.doc.getElementById('account-drawer-details').textContent;
  assert.match(details, /alice/);
  assert.match(details, /alice@example\.com/);
  assert.match(details, /Owner/);
  assert.match(details, /u-1/);
});

test('the drawer renders API values as text (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const env = await accountsEnv([{ ...ACCOUNT, username: XSS, email: XSS, id: XSS, suspension_reason: XSS, account_status: 'suspended', is_active: false }]);
  env.doc.querySelectorAll('#accounts-table tbody tr')[0].click();

  assert.deepEqual(hostileNodes(env.doc), []);
  const details = env.doc.getElementById('account-drawer-details').textContent;
  assert.ok(details.includes(XSS), 'drawer shows the payload as text');
});

test('the drawer offers reactivate for a suspended account and suspend for an active one', async () => {
  const env = await accountsEnv();
  env.doc.querySelectorAll('#accounts-table tbody tr')[0].click();
  assert.match(env.doc.getElementById('account-drawer-actions').textContent, /Suspend account/);

  const suspendedEnv = await accountsEnv([{ ...ACCOUNT, account_status: 'suspended', is_active: false }]);
  suspendedEnv.doc.querySelectorAll('#accounts-table tbody tr')[0].click();
  assert.match(suspendedEnv.doc.getElementById('account-drawer-actions').textContent, /Reactivate account/);
});

test('the drawer action opens the suspend dialog and the drawer closes on demand', async () => {
  const env = await accountsEnv();
  env.doc.querySelectorAll('#accounts-table tbody tr')[0].click();

  const actionBtn = env.doc.getElementById('account-drawer-actions').children[1];
  actionBtn.click();
  assert.equal(env.doc.getElementById('suspend-dialog').open, true);

  env.doc.getElementById('account-drawer-close').click();
  assert.equal(env.doc.getElementById('account-drawer').hidden, true);
  assert.equal(env.doc.getElementById('account-drawer-backdrop').hidden, true);
});
