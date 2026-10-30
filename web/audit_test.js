// Audit viewer and app version policy tests (item 10): the merged audit log
// with its per-source status, the audit filters, the version policy card and
// the policy update (mandatory reason, PUT /api/version).
// Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'audit-token';

const ENTRY = {
  id: '6f1c2a9e0b7d4c3a8e5f1b2c',
  source: 'user-service',
  actor_id: 'rev-sarah-1',
  action: 'job.cancel',
  target_type: 'job',
  target_id: 'job-8812',
  reason: 'Courier vehicle broke down',
  details: 'owner=tenant-55',
  request_id: 'c0ffee12ab34',
  created_at: '2026-10-29T08:30:15Z',
};

const AUDIT_RESPONSE = {
  entries: [ENTRY],
  total: 1,
  page: 1,
  limit: 20,
  sources: {
    'auth-service': 'ok',
    'user-service': 'ok',
    'chat-service': 'ok',
    'notification-service': 'unavailable',
    'api-gateway': 'ok',
  },
};

const VERSION = {
  id: 'global',
  latest_version: '1.5.2',
  minimum_supported_version: '1.4.0',
  enforce_minimum_version: false,
  download_url: 'https://play.google.com/store/apps/details?id=tech.logiclinkeg.app',
  revision: 7,
  updated_at: '2026-10-29T08:30:15Z',
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

async function auditEnv({ audit = AUDIT_RESPONSE, version = VERSION } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/audit')) return jsonResponse(audit);
      if (url.startsWith('/api/version')) {
        if ((options?.method || 'GET') === 'PUT') return jsonResponse({ message: 'version configuration updated successfully' });
        return jsonResponse(version);
      }
      return jsonResponse([]);
    },
  });
  env.ctx.setLanguage('en');
  return { env, calls };
}

test('the audit table renders every record field', async () => {
  const { env } = await auditEnv();
  await env.ctx.loadAudit();

  const text = env.doc.getElementById('audit-table').textContent;
  assert.match(text, /user-service/);
  assert.match(text, /rev-sarah-1/);
  assert.match(text, /job\.cancel/);
  assert.match(text, /job-8812/);
  assert.match(text, /Courier vehicle broke down/);
  assert.match(text, /owner=tenant-55/);
  assert.match(text, /c0ffee12ab34/);
});

test('an unavailable audit source is shown as such', async () => {
  const { env } = await auditEnv();
  await env.ctx.loadAudit();

  const strip = env.doc.getElementById('audit-sources').textContent;
  assert.match(strip, /notification-service: unavailable/);
  assert.match(strip, /user-service: ok/);
});

test('audit filters are sent to the API as query parameters', async () => {
  const { env, calls } = await auditEnv();
  env.doc.getElementById('audit-actor-input').value = 'rev-sarah-1';
  env.doc.getElementById('audit-action-input').value = 'job.cancel';
  env.doc.getElementById('audit-target-input').value = 'job-8812';
  env.doc.getElementById('audit-from-input').value = '2026-10-01';
  env.doc.getElementById('audit-to-input').value = '2026-10-29';
  env.doc.getElementById('audit-filter-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const last = calls[calls.length - 1].url;
  assert.match(last, /actor_id=rev-sarah-1/);
  assert.match(last, /action=job\.cancel/);
  assert.match(last, /target_id=job-8812/);
  assert.match(last, /from=2026-10-01/);
  assert.match(last, /to=2026-10-29/);
});

test('audit rows render API values as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const { env } = await auditEnv({
    audit: { ...AUDIT_RESPONSE, entries: [{ ...ENTRY, actor_id: XSS, action: XSS, reason: XSS, details: XSS, request_id: XSS }] },
  });
  await env.ctx.loadAudit();

  assert.ok(env.doc.getElementById('audit-table').textContent.includes(XSS));
  assert.deepEqual(hostileNodes(env.doc), []);
});

test('the version policy card shows the current policy', async () => {
  const { env } = await auditEnv();
  await env.ctx.loadVersions();

  const card = env.doc.getElementById('versions-card').textContent;
  assert.match(card, /1\.5\.2/);
  assert.match(card, /1\.4\.0/);
  assert.match(card, /not enforced/);

  const link = env.doc.getElementById('versions-card').querySelector('a');
  assert.equal(link.getAttribute('href'), VERSION.download_url);
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('updating the version policy needs a reason and posts every field', async () => {
  const { env, calls } = await auditEnv();
  env.ctx.openVersionUpdateDialog(VERSION);

  env.doc.getElementById('version-update-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'no update without a reason');

  env.doc.getElementById('version-reason-input').value = 'Deprecating API v1 endpoints';
  env.doc.getElementById('version-latest-input').value = '1.5.3';
  env.doc.getElementById('version-minimum-input').value = '1.5.0';
  env.doc.getElementById('version-enforce-input').checked = true;
  env.doc.getElementById('version-update-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'the update request was sent');
  assert.match(put.url, /\/api\/version$/);
  assert.equal(put.body.reason, 'Deprecating API v1 endpoints');
  assert.equal(put.body.latest_version, '1.5.3');
  assert.equal(put.body.minimum_supported_version, '1.5.0');
  assert.equal(put.body.enforce_minimum_version, true);
});

test('an unavailable version policy shows an explicit message', async () => {
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url) => (url.startsWith('/api/version')
      ? jsonResponse({ error: 'internal client certificate required' }, 403)
      : jsonResponse([])),
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadVersions();

  assert.equal(env.doc.getElementById('versions-error').hidden, false);
  assert.match(env.doc.getElementById('versions-card').textContent, /version policy is unavailable/i);
});
