// Shell wiring and boot. main.js has NO top-level side effects: the browser
// entry is web/js/boot.js, the tests call wireAll()/bootstrapSession()
// explicitly with a fresh DOM.

import { api, tokenKey } from './core/api.js';
import state from './core/state.js';
import * as router from './core/router.js';
import * as i18n from './core/i18n.js';
import * as theme from './core/theme.js';
import { logout, markActivity, checkIdle, startIdleWatch, wireActivityListeners } from './core/session.js';
import { openDialog } from './core/ui/dialog.js';
import * as codBanner from './core/cod-banner.js';

import * as overview from './pages/overview.js';
import * as kyc from './pages/kyc.js';
import * as accounts from './pages/accounts.js';
import * as jobs from './pages/jobs.js';
import * as services from './pages/services.js';
import * as kycdocs from './pages/kycdocs.js';
import * as disputes from './pages/disputes.js';
import * as subscriptions from './pages/subscriptions.js';
import * as tickets from './pages/tickets.js';
import * as payouts from './pages/payouts.js';
import * as audit from './pages/audit.js';
import * as versions from './pages/versions.js';

const pages = { overview, kyc, accounts, jobs, services, kycdocs, disputes, subscriptions, tickets, payouts, audit, versions };

// Tab definitions mirror the old switchTab(): one visible section at a time
// plus a data load per activation.
const tabs = {
  overview: { section: 'overview-section', btn: 'tab-overview-btn', load: () => overview.loadOverview() },
  queue: { section: 'queue-section', btn: 'tab-queue-btn', load: () => kyc.loadQueue() },
  accounts: { section: 'accounts-section', btn: 'tab-accounts-btn', load: () => accounts.loadAccounts() },
  jobs: { section: 'jobs-section', btn: 'tab-jobs-btn', load: () => jobs.loadJobs() },
  services: { section: 'services-section', btn: 'tab-services-btn', load: () => services.loadServices() },
  reconciliation: { section: 'reconciliation-section', btn: 'tab-reconciliation-btn', load: () => disputes.loadReconciliation() },
  subscriptions: { section: 'subscriptions-section', btn: 'tab-subscriptions-btn', load: () => subscriptions.loadSubscriptionQueue() },
  tickets: { section: 'tickets-section', btn: 'tab-tickets-btn', load: () => tickets.loadTickets() },
  payouts: { section: 'payouts-section', btn: 'tab-payouts-btn', load: () => payouts.loadPayouts() },
  audit: { section: 'audit-section', btn: 'tab-audit-btn', load: () => audit.loadAudit() },
  versions: { section: 'versions-section', btn: 'tab-versions-btn', load: () => versions.loadVersions() },
};

// Shell strings (nav, header, login area). Page modules add their own areas
// via addTranslations(); the fallback renders the key's last segment, so a
// missing key can never vanish UI text.
function addShellTranslations() {
  i18n.addTranslations('nav', {
    ar: {
      overview: 'نظرة عامة',
      jobs: 'المهام',
      services: 'الخدمات',
      queue: 'قيد المراجعة',
      accounts: 'الحسابات',
      reconciliation: 'النزاعات والمطابقة',
      subscriptions: 'الاشتراكات',
      tickets: 'تذاكر الدعم',
      payouts: 'طلبات الصرف',
      audit: 'سجل التدقيق',
      versions: 'إصدارات التطبيق',
    },
    en: {
      overview: 'Overview',
      jobs: 'Jobs',
      services: 'Services',
      queue: 'Pending Submissions',
      accounts: 'Accounts Directory',
      reconciliation: 'Disputes & Reconciliation',
      subscriptions: 'Subscriptions',
      tickets: 'Support Tickets',
      payouts: 'Payout Requests',
      audit: 'Audit log',
      versions: 'App versions',
    },
  });
  i18n.addTranslations('shell', {
    ar: {
      title: 'وحدة مراجعة الهوية',
      tagline: 'الحوكمة والهوية والحسابات',
      signOut: 'تسجيل الخروج',
      identityFail: '',
    },
    en: {
      title: 'Reviewer Console',
      tagline: 'Identity & Account Governance',
      signOut: 'Sign out',
      identityFail: '',
    },
  });
  i18n.addTranslations('login', {
    ar: {
      title: 'وحدة مراجعة الهوية',
      subtitle: 'مراجعة KYC / KYB / KYE — للاستخدام الداخلي فقط',
      token: 'رمز المراجع',
      signIn: 'تسجيل الدخول',
      invalidToken: 'رمز المراجع غير صالح.',
      signInFailed: 'فشل تسجيل الدخول: {error}',
    },
    en: {
      title: 'Reviewer Console',
      subtitle: 'KYC / KYB / KYE review — internal use only',
      token: 'Reviewer token',
      signIn: 'Sign in',
      invalidToken: 'Invalid reviewer token.',
      signInFailed: 'Sign-in failed: {error}',
    },
  });
}

// translateShell fills every [data-i18n] element from the dictionary.
export function translateShell() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = i18n.t(node.getAttribute('data-i18n'));
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = i18n.t(node.getAttribute('data-i18n-placeholder'));
  }
}

function refreshReviewerIdentityBox() {
  const box = document.getElementById('reviewer-identity');
  if (!box) return;
  const who = state.currentReviewer;
  const name = who && (who.username || who.display_name || who.email);
  box.textContent = name ? `${name} (${who.role || 'reviewer'})` : '';
}

function wireLangToggle(btn) {
  if (!btn) return;
  const label = () => { btn.textContent = i18n.getLanguage() === 'ar' ? 'EN' : 'ع'; };
  label();
  btn.addEventListener('click', () => {
    i18n.setLanguage(i18n.getLanguage() === 'ar' ? 'en' : 'ar');
    label();
    translateShell();
  });
}

// initShell applies the saved language/theme, translates the static shell and
// wires the two toggles. Runs on boot() only — tests re-run it explicitly.
export function initShell() {
  addShellTranslations();
  i18n.setLanguage(i18n.detectLanguage());
  translateShell();
  wireLangToggle(document.getElementById('lang-toggle-btn'));
  theme.applyTheme(theme.getTheme());
  theme.wireThemeToggle(document.getElementById('theme-toggle-btn'));
  refreshReviewerIdentityBox();
}

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
  router.setDefault('overview');
}

export function wireAll() {
  wireTabs();
  for (const page of Object.values(pages)) {
    if (typeof page.wire === 'function') page.wire();
  }
  codBanner.wireCodBanner();

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
    router.navigate('overview');
    tickets.refreshBadgeCounts();
  } catch (err) {
    sessionStorage.clear();
    const el = document.getElementById('login-error');
    el.textContent = err.message === 'unauthorized'
      ? i18n.t('login.invalidToken')
      : i18n.t('login.signInFailed', { error: err.message });
    el.hidden = false;
  }
}

// initReviewerIdentity fetches the reviewer profile once (used by the chat
// bubbles and the shell header).
export async function initReviewerIdentity() {
  try {
    const res = await api('/api/me');
    if (res.ok) {
      state.currentReviewer = await res.json();
    }
  } catch { /* identity is cosmetic */ }
  refreshReviewerIdentityBox();
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

// boot runs everything for a real browser load: language + theme first so the
// first paint is already in the right direction and palette.
export function boot() {
  initShell();
  wireActivityListeners();
  wireAll();
  router.install();
  bootstrapSession();
}

export { overview, kyc, accounts, jobs, services, kycdocs, disputes, subscriptions, tickets, payouts, audit, versions, tabs };
export { openDialog };
