// UI contract tests against the real ES modules: disputes show only fields
// the user-service queue item has, payouts use EGP and saas-core statuses.
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse } = require('./testdom.js');

// CONSOLE-SEC item 5: the user-service reconciliation queue item, exactly as
// saas-core's AdminReconciliationJobItem serialises it (no pickup/dropoff
// address, no category; employee_id is omitempty).
const queueItem = {
  id: '65f0c0ffee0000000000abcd',
  tenant_id: 'owner-1',
  owner_id: 'owner-1',
  customer_id: 'cust-1',
  service_id: 'svc-1',
  booked_distance: 10,
  actual_distance: 4,
  waypoints_count: 3,
  locked_escrow_amount: 120.5,
  actual_amount: 0,
  payment_method: 'wallet',
  status: 'escrow_reconciliation_required',
  reconciliation_note: '',
  reconciliation_reason: 'under_distance_mismatch',
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:05:00Z',
};

test('dispute dialog shows only fields the queue item has', async () => {
  const env = await loadApp();
  // The console is Arabic by default; these assertions read the English
  // labels, so the language is pinned explicitly.
  env.ctx.setLanguage('en');
  env.ctx.openResolveDisputeDialog(queueItem);
  const text = env.doc.getElementById('resolve-dispute-details').textContent;
  assert.doesNotMatch(text, /undefined|\(none\)|Route|Category|→/);
  assert.doesNotMatch(text, /Assigned Courier/, 'no courier row without employee_id');
  assert.match(text, /Service: svc-1/);
  assert.match(text, /10\.0 km vs 4\.0 km \(40%\), 3 waypoints/);
  assert.match(text, /Locked Escrow: 120\.50 EGP/);
  assert.match(text, /Customer: cust-1/);
  assert.match(text, /Flag Reason: under_distance_mismatch/);

  env.ctx.openResolveDisputeDialog({ ...queueItem, employee_id: 'courier-9' });
  assert.match(env.doc.getElementById('resolve-dispute-details').textContent, /Assigned Courier: courier-9/);
});

test('dispute rows show no invented route or category', async () => {
  const env = await loadApp({ fetch: async () => jsonResponse({ disputes: [queueItem], total: 1 }) });
  await env.ctx.loadReconciliation();
  const text = env.doc.getElementById('reconciliation-table').textContent;
  assert.doesNotMatch(text, /undefined|Pickup|Dropoff|&rarr;|Delivery/);
  assert.match(text, /svc-1/);
});

test('payouts are shown in EGP with saas-core statuses', async () => {
  const env = await loadApp({
    fetch: async () => jsonResponse({ payouts: [{ id: 'po1', tenant_id: 't1', amount: 250, status: 'paid', payout_method: 'instapay' }], total: 1 }),
  });
  await env.ctx.loadPayouts();
  const table = env.doc.getElementById('payouts-table');
  assert.match(table.textContent, /250\.00 EGP/);
  assert.doesNotMatch(table.textContent, /\$/);
  assert.ok(table.querySelector('.badge-paid'), 'paid payouts use the paid badge');

  env.ctx.openRejectPayoutDialog({ id: 'po2', tenant_id: 't1', amount: 99.5 });
  assert.match(env.doc.getElementById('reject-payout-target').textContent, /99\.50 EGP/);

  const filterValues = env.doc.querySelectorAll('#payouts-status-filter option').map((o) => o.value);
  assert.deepEqual(filterValues, ['', 'requested', 'approved', 'paid', 'rejected']);
});
