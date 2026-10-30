// Jobs page tests: search, job detail (PII included, audited upstream) and
// the two support mutations (cancel, complete stuck COD) with their mandatory
// reason. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'jobs-token';

const JOB = {
  id: 'job-98712',
  status: 'active',
  sub_status: 'in_transit',
  owner_id: 'tenant-xyz',
  user_id: 'usr-101',
  employee_id: 'usr-202',
  payment_method: 'cod',
  suggested_price: 85.5,
  customer_name: 'Mona',
  recipient: { name: 'Mona Recipient', phone: '+201011112222' },
  created_at: '2026-10-29T08:15:00Z',
};

const DETAIL = {
  ...JOB,
  customer_phone: '+201012345678',
  courier_name: 'Tariq Courier',
  courier_phone: '+201098765432',
  pickup_address: '15 Nile Corniche, Cairo',
  dropoff_address: '44 El-Tahrir St, Giza',
  package: { description: 'Laptop charger', weight_kg: 0.8 },
  price: 85.5,
  locked_escrow_amount: 0,
  reconciliation: { stuck_cod: false, gps_dispute: false },
  status_history: [
    { status: 'pending', timestamp: '2026-10-29T08:15:00Z' },
    { status: 'active', timestamp: '2026-10-29T08:35:12Z' },
  ],
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

async function jobsEnv({ jobs = [JOB], detail = DETAIL } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/jobs?')) return jsonResponse({ jobs, total: jobs.length, page: 1, limit: 20 });
      if (url.startsWith('/api/jobs/') && (options?.method || 'GET') === 'GET') return jsonResponse(detail);
      return jsonResponse({ success: true });
    },
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadJobs();
  return { env, calls };
}

test('the jobs list renders status, price and recipient from the API', async () => {
  const { env } = await jobsEnv();
  const text = env.doc.getElementById('jobs-table').textContent;
  assert.match(text, /job-98712/);
  assert.match(text, /On the way/);
  assert.match(text, /in_transit/);
  assert.match(text, /Mona/);
  assert.match(text, /\+201011112222/);
  assert.match(text, /85\.50 EGP/);
  assert.match(text, /Cash on delivery/);
  assert.doesNotMatch(text, /\$/, 'no dollar amounts');
});

test('job filters are sent to the API as query parameters', async () => {
  const { env, calls } = await jobsEnv();
  env.doc.getElementById('jobs-id-input').value = 'job-98712';
  env.doc.getElementById('jobs-customer-input').value = 'usr-101';
  env.doc.getElementById('jobs-status-filter').value = 'active';
  env.doc.getElementById('jobs-filter-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const last = calls[calls.length - 1].url;
  assert.match(last, /job_id=job-98712/);
  assert.match(last, /customer_id=usr-101/);
  assert.match(last, /status=active/);
});

test('the job detail dialog shows phones, addresses and the status history', async () => {
  const { env } = await jobsEnv();
  env.doc.querySelectorAll('#jobs-table tbody tr')[0].querySelector('button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(env.doc.getElementById('job-detail-dialog').open, true);
  const body = env.doc.getElementById('job-detail-body').textContent;
  assert.match(body, /\+201012345678/);
  assert.match(body, /\+201098765432/);
  assert.match(body, /15 Nile Corniche/);
  assert.match(body, /44 El-Tahrir St/);
  const history = env.doc.getElementById('job-detail-history').textContent;
  assert.match(history, /Waiting for courier/);
  assert.match(history, /On the way/);
});

test('job detail renders API values as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const { env } = await jobsEnv({
    jobs: [{ ...JOB, customer_name: XSS, recipient: { name: XSS, phone: XSS } }],
    detail: { ...DETAIL, customer_name: XSS, customer_phone: XSS, pickup_address: XSS },
  });
  env.doc.querySelectorAll('#jobs-table tbody tr')[0].querySelector('button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(hostileNodes(env.doc), []);
  assert.ok(env.doc.getElementById('job-detail-body').textContent.includes(XSS));
});

test('cancelling a job requires a reason and then posts it', async () => {
  const { env, calls } = await jobsEnv();
  const cancelBtn = env.doc.querySelectorAll('#jobs-table tbody tr')[0].querySelectorAll('button')[1];
  cancelBtn.click();

  env.doc.getElementById('job-cancel-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no POST without a reason');
  assert.equal(env.doc.getElementById('job-cancel-error').hidden, false);

  env.doc.getElementById('job-cancel-reason').value = 'duplicate order';
  env.doc.getElementById('job-cancel-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'cancel request was sent');
  assert.match(post.url, /\/api\/jobs\/job-98712\/cancel$/);
  assert.equal(post.body.reason, 'duplicate order');
});

test('completing a stuck COD job posts to the repair endpoint', async () => {
  const { env, calls } = await jobsEnv();
  env.ctx.openJobCodDialog(JOB);
  env.doc.getElementById('job-cod-reason').value = 'cash collected, verified by phone';
  env.doc.getElementById('job-cod-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'complete-stuck-cod request was sent');
  assert.match(post.url, /\/api\/jobs\/job-98712\/complete-stuck-cod$/);
  assert.equal(post.body.reason, 'cash collected, verified by phone');
});
