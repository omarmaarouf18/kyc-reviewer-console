// Services marketplace moderation tests: list rendering, filters and the
// three moderation actions (hide, unhide, photo removal) with their mandatory
// reason. Run with: node --test web/*_test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, hostileNodes } = require('./testdom.js');

const TOKEN_KEY = 'reviewer_token';
const TOKEN = 'svc-token';

const SERVICE = {
  id: 'svc-555',
  tenant_id: 'tenant-fast-courier',
  name: 'Express Same-Day Delivery',
  photo_url: 'https://storage.logiclinkeg.tech/services/svc-555.jpg',
  is_hidden: true,
  hidden_reason: 'Prohibited items listed in description',
  hidden_by: 'rev-sarah-1',
};

function signedIn() {
  return new Map([[TOKEN_KEY, TOKEN], ['reviewer_last_activity', String(Date.now())]]);
}

async function servicesEnv({ services = [SERVICE] } = {}) {
  const calls = [];
  const env = await loadApp({
    storage: signedIn(),
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      if (url.startsWith('/api/services?')) return jsonResponse({ services, total: services.length, page: 1, limit: 20 });
      return jsonResponse({ success: true });
    },
  });
  env.ctx.setLanguage('en');
  await env.ctx.loadServices();
  return { env, calls };
}

test('the services list renders name, tenant, photo and moderation state', async () => {
  const { env } = await servicesEnv();
  const text = env.doc.getElementById('services-table').textContent;
  assert.match(text, /Express Same-Day Delivery/);
  assert.match(text, /svc-555/);
  assert.match(text, /tenant-fast-courier/);
  assert.match(text, /Hidden/);
  assert.match(text, /Prohibited items listed in description/);
  assert.match(text, /rev-sarah-1/);

  const link = env.doc.getElementById('services-table').querySelector('a');
  assert.equal(link.getAttribute('href'), SERVICE.photo_url);
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('service filters are sent to the API as query parameters', async () => {
  const { env, calls } = await servicesEnv();
  env.doc.getElementById('services-tenant-input').value = 'tenant-fast-courier';
  env.doc.getElementById('services-hidden-filter').value = 'true';
  env.doc.getElementById('services-photo-filter').value = 'true';
  env.doc.getElementById('services-filter-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const last = calls[calls.length - 1].url;
  assert.match(last, /tenant_id=tenant-fast-courier/);
  assert.match(last, /hidden=true/);
  assert.match(last, /has_photo=true/);
});

test('a service action requires a reason and then posts to its endpoint', async () => {
  const { env, calls } = await servicesEnv();
  // The service is hidden, so the first action button is "unhide".
  env.doc.querySelectorAll('#services-table tbody tr')[0].querySelector('button').click();
  assert.equal(env.doc.getElementById('service-action-dialog').open, true);

  env.doc.getElementById('service-action-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no POST without a reason');
  assert.equal(env.doc.getElementById('service-action-error').hidden, false);

  env.doc.getElementById('service-action-reason').value = 'merchant complied with the terms';
  env.doc.getElementById('service-action-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'action request was sent');
  assert.match(post.url, /\/api\/services\/svc-555\/unhide$/);
  assert.equal(post.body.reason, 'merchant complied with the terms');
});

test('hiding a visible service and removing its photo use their own endpoints', async () => {
  const { env, calls } = await servicesEnv({ services: [{ ...SERVICE, is_hidden: false, hidden_reason: '', hidden_by: '' }] });
  const buttons = env.doc.querySelectorAll('#services-table tbody tr')[0].querySelectorAll('button');

  buttons[0].click();
  env.doc.getElementById('service-action-reason').value = 'policy violation';
  env.doc.getElementById('service-action-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const hidePost = calls.find((c) => c.method === 'POST');
  assert.match(hidePost.url, /\/api\/services\/svc-555\/hide$/);

  env.doc.querySelectorAll('#services-table tbody tr')[0].querySelectorAll('button')[1].click();
  env.doc.getElementById('service-action-reason').value = 'copyrighted image';
  env.doc.getElementById('service-action-submit').click();
  await new Promise((resolve) => setImmediate(resolve));

  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[1].url, /\/api\/services\/svc-555\/photo\/remove$/);
  assert.equal(posts[1].body.reason, 'copyrighted image');
});

test('service rows render API values as text only (stored XSS regression)', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const { env } = await servicesEnv({ services: [{ ...SERVICE, name: XSS, tenant_id: XSS, hidden_reason: XSS, hidden_by: XSS }] });
  const text = env.doc.getElementById('services-table').textContent;
  assert.ok(text.includes(XSS));
  assert.deepEqual(hostileNodes(env.doc), []);
});
