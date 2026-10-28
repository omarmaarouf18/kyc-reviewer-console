// Stored-XSS regression tests: API values carrying HTML payloads must render
// as text, never as elements or attributes. Runs the real app.js against the
// real index.html (see testdom.js).
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const XSS = '<img src=x onerror=alert(1)>';

function assertInert(env, scopeId) {
  assert.deepEqual(hostileNodes(env.doc), []);
  const scope = env.doc.getElementById(scopeId);
  assert.ok(scope.textContent.includes(XSS), `payload should be visible as text in #${scopeId}`);
}

test('dispute dialog renders API fields as text', () => {
  const env = loadApp();
  env.ctx.openResolveDisputeDialog({
    id: XSS,
    tenant_id: XSS,
    owner_id: XSS,
    employee_id: XSS,
    customer_id: XSS,
    service_id: XSS,
    booked_distance: XSS,
    actual_distance: 3,
    waypoints_count: XSS,
    locked_escrow_amount: XSS,
    payment_method: XSS,
    status: XSS,
    reconciliation_note: XSS,
    reconciliation_reason: XSS,
    category: XSS,
    pickup_address: XSS,
    dropoff_address: XSS,
  });
  assertInert(env, 'resolve-dispute-details');
});

test('dispute rows render API fields as text', async () => {
  const env = loadApp({
    fetch: async () => jsonResponse({
      disputes: [{ id: XSS, owner_id: XSS, customer_id: XSS, booked_distance: 1, actual_distance: 1, waypoints_count: XSS, locked_escrow_amount: XSS, payment_method: XSS, reconciliation_reason: XSS }],
      total: 1,
    }),
  });
  await env.ctx.loadReconciliation();
  assertInert(env, 'reconciliation-table');
});

test('account row renders API fields as text', async () => {
  const env = loadApp({
    fetch: async () => jsonResponse({
      accounts: [{ id: XSS, username: XSS, email: XSS, role: XSS, kyc_status: XSS, account_status: 'suspended', suspension_reason: XSS, created_at: XSS }],
      total: 1,
    }),
  });
  await env.ctx.loadAccounts();
  assertInert(env, 'accounts-table');
});

test('ticket message renders sender, content and file name as text', () => {
  const env = loadApp();
  env.ctx.appendChatMessage({ sender_username: XSS, sender_id: XSS, content: XSS, timestamp: new Date().toISOString() });
  env.ctx.appendChatMessage({ type: 'system', content: XSS });
  env.ctx.appendChatMessage({ sender_username: 'c', content: 'see file', attachment_url: '/x?token=t', attachment_type: 'application/pdf', attachment_name: XSS, attachment_size: 10 });
  assertInert(env, 'ticket-chat-messages');
});

test('ticket rows and resolve dialog render API fields as text', async () => {
  const ticket = { ticket_id: XSS, customer_id: XSS, subject: XSS, context_id: XSS, status: XSS, assigned_agent_id: XSS, resolved_by: XSS, created_at: XSS };
  const env = loadApp({ fetch: async () => jsonResponse({ tickets: [ticket], total: 1 }) });
  await env.ctx.loadTickets();
  assertInert(env, 'tickets-table');
  env.ctx.openResolveTicketDialog(ticket);
  assertInert(env, 'resolve-ticket-details');
});

test('payout row renders API fields as text', async () => {
  const env = loadApp({
    fetch: async () => jsonResponse({
      payouts: [
        { id: XSS, tenant_id: XSS, amount: XSS, payout_method: XSS, status: 'rejected', rejection_reason: XSS, created_at: XSS },
        { id: 'p2', tenant_id: 't', amount: 1, payout_method: 'instapay', status: XSS },
      ],
      total: 2,
    }),
  });
  await env.ctx.loadPayouts();
  assertInert(env, 'payouts-table');
});

test('subscription row renders API fields as text', async () => {
  const env = loadApp({
    fetch: async () => jsonResponse({
      subscriptions: [{ id: XSS, tenant_id: XSS, tier: XSS, activated_by: XSS, revoked_by: XSS, reason: XSS }],
      total: 1,
    }),
  });
  await env.ctx.loadSubscriptions();
  assertInert(env, 'subscriptions-table');
});

test('KYC queue row and user-docs status bar render API fields as text', async () => {
  const env = loadApp({
    fetch: async (url) => (url.startsWith('/api/queue')
      ? jsonResponse([{ user_id: XSS, username: XSS, email: XSS, role: XSS, document_errors: [XSS] }])
      : jsonResponse({ kyc_status: XSS, kye_status: XSS, document_errors: [XSS] })),
  });
  await env.ctx.loadQueue();
  assertInert(env, 'queue-table');
  await env.ctx.retrieveUserDocs({ id: 'u1' }, 'audit');
  assertInert(env, 'user-docs-results');
});

test('documents with a scriptable content type open as downloads, not inline', async () => {
  const env = loadApp({
    fetch: async () => ({ status: 200, ok: true, blob: async () => new Blob(['<script>alert(1)</script>'], { type: 'text/html' }) }),
  });
  let madeType = null;
  env.ctx.URL.createObjectURL = (b) => { madeType = b.type; return 'blob:x'; };
  await env.ctx.openDocument('/auth/documents/view?token=abc');
  assert.equal(madeType, 'application/octet-stream');
  await env.ctx.openAttachment('/chat/attachments/view?token=abc');
  assert.equal(madeType, 'application/octet-stream');
});
