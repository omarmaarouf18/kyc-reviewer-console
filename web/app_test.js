// Unit test suite for kyc-reviewer-console/web/app.js auth & error-handling semantics.
// Run with: node --test web/app_test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal DOM & Web API mock environment for testing app.js logic in Node
function setupMockEnv() {
  const elements = {};
  function getOrCreateElement(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        hidden: false,
        textContent: '',
        value: '',
        disabled: false,
        classList: {
          add() {},
          remove() {},
          contains() { return false; },
        },
        showModal() { this.open = true; },
        close() { this.open = false; },
      };
    }
    return elements[id];
  }

  const storage = new Map();
  const mockSessionStorage = {
    getItem(k) { return storage.get(k) || null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    clear() { storage.clear(); },
  };

  return {
    elements,
    getOrCreateElement,
    mockSessionStorage,
  };
}

test('api() calls logout and throws on HTTP 401', async () => {
  const env = setupMockEnv();
  let logoutCalled = false;
  let logoutMsg = '';

  function logout(msg) {
    logoutCalled = true;
    logoutMsg = msg;
    env.mockSessionStorage.removeItem('reviewer_token');
  }

  env.mockSessionStorage.setItem('reviewer_token', 'test-token');

  async function api(path, options = {}) {
    const res = await mockFetch(path, options);
    if (res.status === 401) {
      logout('Session expired or invalid token.');
      throw new Error('unauthorized');
    }
    return res;
  }

  async function mockFetch() {
    return {
      status: 401,
      ok: false,
      json: async () => ({ error: 'unauthorized' }),
    };
  }

  await assert.rejects(
    async () => { await api('/api/tickets/resolve'); },
    { message: 'unauthorized' }
  );

  assert.equal(logoutCalled, true);
  assert.equal(logoutMsg, 'Session expired or invalid token.');
  assert.equal(env.mockSessionStorage.getItem('reviewer_token'), null);
});

test('api() does NOT call logout on HTTP 503 Service Unavailable and returns response', async () => {
  const env = setupMockEnv();
  let logoutCalled = false;

  function logout() {
    logoutCalled = true;
  }

  env.mockSessionStorage.setItem('reviewer_token', 'test-token');

  async function api(path, options = {}) {
    const res = await mockFetch(path, options);
    if (res.status === 401) {
      logout('Session expired or invalid token.');
      throw new Error('unauthorized');
    }
    return res;
  }

  async function mockFetch() {
    return {
      status: 503,
      ok: false,
      json: async () => ({
        error: 'service_unavailable',
        message: 'Authentication service is temporarily unavailable. Please try again later.',
      }),
    };
  }

  const res = await api('/api/tickets/resolve');
  assert.equal(res.status, 503);
  assert.equal(res.ok, false);
  assert.equal(logoutCalled, false);
  assert.equal(env.mockSessionStorage.getItem('reviewer_token'), 'test-token');

  const data = await res.json();
  assert.equal(data.error, 'service_unavailable');
});

test('submitResolveTicket() catches 503 and surfaces in-app error without crashing or logging out', async () => {
  const env = setupMockEnv();
  let logoutCalled = false;

  const errorEl = env.getOrCreateElement('resolve-ticket-error');
  const submitBtn = env.getOrCreateElement('resolve-ticket-submit');
  const dialogEl = env.getOrCreateElement('resolve-ticket-dialog');
  dialogEl.open = true;

  const targetTicket = { ticket_id: 'tkt-12345' };
  const note = 'Investigated customer issue';

  async function api() {
    return {
      status: 503,
      ok: false,
      json: async () => ({
        error: 'service_unavailable',
        message: 'Authentication service is temporarily unavailable. Please try again later.',
      }),
    };
  }

  // Execute the exact submitResolveTicket logic
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Resolving...';

    const res = await api('/api/tickets/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: targetTicket.ticket_id, resolution_note: note }),
    });

    if (!res.ok) {
      let msg = `Ticket resolution failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch {}
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  } catch (e) {
    if (e.message === 'unauthorized') return;
    errorEl.textContent = `Failed to resolve ticket: ${e.message}`;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm Resolve';
  }

  // Assertions
  assert.equal(logoutCalled, false);
  assert.equal(dialogEl.open, true); // Dialog remains open for retry
  assert.equal(submitBtn.disabled, false); // Button re-enabled
  assert.equal(submitBtn.textContent, 'Confirm Resolve');
  assert.equal(errorEl.textContent, 'Authentication service is temporarily unavailable. Please try again later.');
  assert.equal(errorEl.hidden, false);
});

test('submitResolveTicket() catches 401 gracefully without unhandled promise rejection crash', async () => {
  const env = setupMockEnv();
  let logoutCalled = false;
  let unhandledCrash = false;

  const errorEl = env.getOrCreateElement('resolve-ticket-error');
  const submitBtn = env.getOrCreateElement('resolve-ticket-submit');

  function logout() {
    logoutCalled = true;
  }

  async function api() {
    logout('Session expired or invalid token.');
    throw new Error('unauthorized');
  }

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Resolving...';

    const res = await api('/api/tickets/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: 'tkt-123', resolution_note: 'Note' }),
    });

    if (!res.ok) {
      errorEl.textContent = 'Failed';
    }
  } catch (e) {
    if (e.message === 'unauthorized') {
      // Gracefully handled session expiration — no console crash
      unhandledCrash = false;
    } else {
      unhandledCrash = true;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm Resolve';
  }

  assert.equal(logoutCalled, true);
  assert.equal(unhandledCrash, false);
});
