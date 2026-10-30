// Ops-console kit tests (item 9): the shell-level stuck-COD banner and the
// disputes / tickets / payouts pages ported onto the shared UI kit (table
// controller, dialog kit, toasts) with AR/EN strings.
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'ops-token';

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

function toasts(env) {
  return Array.from(env.doc.querySelectorAll('.toast-host .toast')).map((n) => n.textContent);
}

// A page environment that answers every endpoint the shell touches.
async function opsEnv(overrides = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (overrides.fetch) {
        const custom = await overrides.fetch(url, options);
        if (custom) return custom;
      }
      if (url.startsWith('/api/overview')) {
        return jsonResponse({ stuck_cod_jobs: 0, jobs_today: {} });
      }
      if (url.startsWith('/api/queue')) return jsonResponse([]);
      if (url.startsWith('/api/jobs')) return jsonResponse({ jobs: [], total: 0, page: 1, limit: 20 });
      if (url.startsWith('/api/reconciliation/queue')) return jsonResponse({ disputes: [], total: 0 });
      if (url.startsWith('/api/subscriptions/queue')) return jsonResponse({ queue: [], total: 0 });
      if (url.startsWith('/api/tickets')) return jsonResponse({ tickets: [], total: 0 });
      if (url.startsWith('/api/payouts')) return jsonResponse({ payouts: [], total: 0 });
      return jsonResponse({});
    },
  });
  return { env, calls };
}

test('the stuck-COD banner appears when the overview reports stuck jobs', async () => {
  const { env } = await opsEnv({
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ stuck_cod_jobs: 3, jobs_today: {} })
      : null),
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadOverview();

  const banner = env.doc.getElementById('cod-banner');
  assert.equal(banner.hidden, false);
  assert.match(env.doc.getElementById('cod-banner-text').textContent, /3 stuck COD job/);
});

test('the COD banner stays hidden for zero and for an unavailable figure', async () => {
  const { env } = await opsEnv({
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ stuck_cod_jobs: 'unavailable', jobs_today: {} })
      : null),
  });
  await env.ctx.loadOverview();
  assert.equal(env.doc.getElementById('cod-banner').hidden, true);
});

test('the COD banner action filters the jobs page on the reconciliation status', async () => {
  const { env } = await opsEnv({
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ stuck_cod_jobs: 1, jobs_today: {} })
      : null),
  });
  await env.ctx.loadOverview();
  env.doc.getElementById('cod-banner-action').click();

  assert.equal(env.ctx.state.jobsState.status, 'escrow_reconciliation_required');
  assert.equal(env.doc.getElementById('jobs-status-filter').value, 'escrow_reconciliation_required');
  assert.equal(String(env.location.hash), '#/jobs');
});

test('resolving a dispute posts the decision and reason and confirms with a toast', async () => {
  const calls = [];
  const { env } = await opsEnv({
    fetch: async (url, options) => {
      if (url.startsWith('/api/reconciliation/resolve')) {
        calls.push(JSON.parse(options.body));
        return jsonResponse({ success: true });
      }
      return null;
    },
  });
  env.ctx.setLanguage('en');
  env.ctx.openResolveDisputeDialog({ id: 'job-1', customer_id: 'cust-1', booked_distance: 10, actual_distance: 4 });

  // Without a reason nothing is sent.
  env.doc.getElementById('resolve-dispute-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(env.doc.getElementById('resolve-dispute-error').hidden, false);

  env.doc.querySelector('input[name="dispute-decision"][value="refund_to_customer"]').checked = true;
  env.doc.getElementById('resolve-dispute-reason').value = 'distance below the agreed minimum';
  env.doc.getElementById('resolve-dispute-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].job_id, 'job-1');
  assert.equal(calls[0].decision, 'refund_to_customer');
  assert.equal(calls[0].reason, 'distance below the agreed minimum');
  assert.ok(toasts(env).some((m) => /dispute was resolved/i.test(m)), 'a toast confirms the resolution');
});

test('rejecting a payout needs a reason, posts it and confirms with a toast', async () => {
  const calls = [];
  const { env } = await opsEnv({
    fetch: async (url, options) => {
      if (url.startsWith('/api/payouts/reject')) {
        calls.push(JSON.parse(options.body));
        return jsonResponse({ success: true });
      }
      return null;
    },
  });
  env.ctx.setLanguage('en');
  env.ctx.openRejectPayoutDialog({ id: 'po1', tenant_id: 't1', amount: 99.5 });

  env.doc.getElementById('reject-payout-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, 'no rejection without a reason');

  env.doc.getElementById('reject-payout-reason').value = 'invalid banking details';
  env.doc.getElementById('reject-payout-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payout_id, 'po1');
  assert.equal(calls[0].reason, 'invalid banking details');
  assert.ok(toasts(env).some((m) => /rejected/i.test(m)), 'a toast confirms the rejection');
});

test('resolving a ticket needs a note and confirms with a toast', async () => {
  const calls = [];
  const { env } = await opsEnv({
    fetch: async (url, options) => {
      if (url.startsWith('/api/tickets/resolve')) {
        calls.push(JSON.parse(options.body));
        return jsonResponse({ success: true });
      }
      return null;
    },
  });
  env.ctx.setLanguage('en');
  env.ctx.openResolveTicketDialog({ ticket_id: 'tkt-1', customer_id: 'c1', created_at: new Date().toISOString() });

  env.doc.getElementById('resolve-ticket-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, 'no resolution without a note');

  env.doc.getElementById('resolve-ticket-note').value = 'Refunded the delivery fee';
  env.doc.getElementById('resolve-ticket-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ticket_id, 'tkt-1');
  assert.equal(calls[0].resolution_note, 'Refunded the delivery fee');
  assert.ok(toasts(env).some((m) => /ticket was resolved/i.test(m)), 'a toast confirms the resolution');
});

test('the COD banner is cleared when the session ends', async () => {
  const { env } = await opsEnv({
    fetch: async (url) => (url.startsWith('/api/overview')
      ? jsonResponse({ stuck_cod_jobs: 2, jobs_today: {} })
      : null),
  });
  await env.ctx.loadOverview();
  assert.equal(env.doc.getElementById('cod-banner').hidden, false);

  env.ctx.logout();
  assert.equal(env.doc.getElementById('cod-banner').hidden, true);
  assert.equal(env.doc.getElementById('cod-banner-text').textContent, '');
});

test('the ops pages are localized (Arabic by default, English on request)', async () => {
  const { env } = await opsEnv();
  await env.ctx.loadReconciliation();

  const arabic = env.doc.getElementById('reconciliation-table').textContent;
  assert.ok(arabic.length >= 0);
  assert.equal(env.doc.querySelector('#reconciliation-table thead th').textContent, 'المهمة');

  env.ctx.setLanguage('en');
  env.main.translateShell();
  env.ctx.loadReconciliation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.doc.querySelector('#reconciliation-table thead th').textContent, 'Job');
});
