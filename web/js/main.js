// Shell wiring and boot. main.js has NO top-level side effects: the browser
// entry is web/js/boot.js, the tests call wireAll()/bootstrapSession()
// explicitly with a fresh DOM.

import { api, tokenKey } from './core/api.js';
import * as router from './core/router.js';
import { logout, markActivity, checkIdle, startIdleWatch, wireActivityListeners } from './core/session.js';
import { openDialog } from './core/ui/dialog.js';

import * as kyc from './pages/kyc.js';
import * as accounts from './pages/accounts.js';
import * as kycdocs from './pages/kycdocs.js';
import * as disputes from './pages/disputes.js';
import * as subscriptions from './pages/subscriptions.js';
import * as tickets from './pages/tickets.js';
import * as payouts from './pages/payouts.js';

const pages = { kyc, accounts, kycdocs, disputes, subscriptions, tickets, payouts };

// Tab definitions mirror the old switchTab(): one visible section at a time
// plus a data load per activation.
const tabs = {
  queue: { section: 'queue-section', btn: 'tab-queue-btn', load: () => kyc.loadQueue() },
  accounts: { section: 'accounts-section', btn: 'tab-accounts-btn', load: () => accounts.loadAccounts() },
  reconciliation: { section: 'reconciliation-section', btn: 'tab-reconciliation-btn', load: () => disputes.loadReconciliation() },
  subscriptions: { section: 'subscriptions-section', btn: 'tab-subscriptions-btn', load: () => subscriptions.loadSubscriptions() },
  tickets: { section: 'tickets-section', btn: 'tab-tickets-btn', load: () => tickets.loadTickets() },
  payouts: { section: 'payouts-section', btn: 'tab-payouts-btn', load: () => payouts.loadPayouts() },
};

function wireTabs() {
  const navButtons = {};
  for (const [route, tab] of Object.entries(tabs)) {
    const btn = document.getElementById(tab.btn);
    if (btn) {
      btn.addEventListener('click', () => router.navigate(route));
      navButtons[route] = btn;
    }
  }
  for (const [route, tab] of Object.entries(tabs)) {
    router.register(route, () => {
      for (const [name, t] of Object.entries(tabs)) {
        const section = document.getElementById(t.section);
        if (!section) continue;
        if (name === route) section.hidden = false;
        else section.hidden = true;
      }
      tab.load();
    }, navButtons[route]);
  }
  router.setDefault('queue');
}

export function wireAll() {
  wireTabs();
  for (const page of Object.values(pages)) {
    if (typeof page.wire === 'function') page.wire();
  }

  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', (e) => onLoginSubmit(e));

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', () => logout());
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const tok = document.getElementById('token').value.trim();
  if (!tok) return;

  sessionStorage.setItem(tokenKey, tok);
  document.getElementById('token').value = '';
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markActivity();
    startIdleWatch();
    document.getElementById('login-view').hidden = true;
    document.getElementById('login-error').hidden = true;
    document.getElementById('app-view').hidden = false;
    initReviewerIdentity();
    // Default page after sign-in; the hash drives it (browser) or render()
    // runs directly (tests / same hash).
    router.navigate('queue');
    tickets.refreshBadgeCounts();
  } catch (err) {
    sessionStorage.clear();
    const el = document.getElementById('login-error');
    el.textContent = err.message === 'unauthorized'
      ? 'Invalid reviewer token.' : `Sign-in failed: ${err.message}`;
    el.hidden = false;
  }
}

// initReviewerIdentity fetches the reviewer profile once (used by the chat
// bubbles and, later, the shell header).
export async function initReviewerIdentity() {
  try {
    const res = await api('/api/me');
    if (res.ok) {
      state.currentReviewer = await res.json();
    }
  } catch { /* identity is cosmetic */ }
}

// bootstrapSession resumes an existing session on page load (bottom of the
// old app.js): a stale idle timeout signs out on the spot.
export function bootstrapSession() {
  const existingSessionToken = sessionStorage.getItem(tokenKey);
  if (existingSessionToken && !checkIdle()) {
    startIdleWatch();
    document.getElementById('login-view').hidden = true;
    document.getElementById('login-error').hidden = true;
    document.getElementById('app-view').hidden = false;
    initReviewerIdentity();
    router.render();
    tickets.refreshBadgeCounts();
  }
}

// boot runs everything for a real browser load.
export function boot() {
  wireActivityListeners();
  wireAll();
  router.install();
  bootstrapSession();
}

export { kyc, accounts, kycdocs, disputes, subscriptions, tickets, payouts, tabs };
export { openDialog };
