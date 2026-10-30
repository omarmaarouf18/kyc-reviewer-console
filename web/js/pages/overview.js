// Overview (ADMIN_API § 2): operational counts from GET /admin/overview via
// the console proxy. Figures for a backend that fails inside user-service
// arrive as the string "unavailable"; the response stays 200.

import { api, isUnauthorized } from '../core/api.js';
import { el, show, hide } from '../core/dom.js';
import { addTranslations, t } from '../core/i18n.js';

// Overview strings: labels for the stat cards, AR first (RTL is the default).
addTranslations('overview', {
  ar: {
    title: 'نظرة عامة',
    refresh: 'تحديث',
    pendingKyc: 'مراجعات KYB/KYE بانتظار المراجعة',
    pendingSubs: 'اشتراكات بانتظار الدفع',
    openTickets: 'تذاكر مفتوحة',
    assignedTickets: 'تذاكر معيَّنة لمندوب',
    gpsDisputes: 'نزاعات GPS',
    stuckCod: 'مهام COD عالقة',
    newAccountsToday: 'حسابات جديدة اليوم',
    newAccounts7d: 'حسابات جديدة (7 أيام)',
    suspendedAccounts: 'حسابات موقوفة',
    unavailable: 'غير متاح',
    loading: 'جارٍ التحميل…',
    error: 'فشل تحميل النظرة العامة: {error}',
    jobGroups: 'مهام اليوم حسب الحالة',
    jobsPendingDispatch: 'بانتظار توزيع مندوب',
    jobsActive: 'قيد التنفيذ',
    jobsCompleted: 'مكتملة',
    jobsCancelled: 'ملغاة',
  },
  en: {
    title: 'Overview',
    refresh: 'Refresh',
    pendingKyc: 'Pending KYB/KYE reviews',
    pendingSubs: 'Subscriptions pending payment',
    openTickets: 'Open tickets',
    assignedTickets: 'Assigned tickets',
    gpsDisputes: 'GPS disputes',
    stuckCod: 'Stuck COD jobs',
    newAccountsToday: 'New accounts today',
    newAccounts7d: 'New accounts (7d)',
    suspendedAccounts: 'Suspended accounts',
    unavailable: 'unavailable',
    loading: 'Loading…',
    error: 'Failed to load overview: {error}',
    jobGroups: "Today's jobs by status",
    jobsPendingDispatch: 'Pending dispatch',
    jobsActive: 'Active',
    jobsCompleted: 'Completed',
    jobsCancelled: 'Cancelled',
  },
});

// Cards render only these backend keys; unknown payload fields are ignored.
const cards = [
  ['pending_kyb_kye', 'overview.pendingKyc'],
  ['pending_payment_subscriptions', 'overview.pendingSubs'],
  ['open_tickets', 'overview.openTickets'],
  ['assigned_tickets', 'overview.assignedTickets'],
  ['gps_disputes', 'overview.gpsDisputes'],
  ['stuck_cod_jobs', 'overview.stuckCod'],
  ['new_accounts_today', 'overview.newAccountsToday'],
  ['new_accounts_7d', 'overview.newAccounts7d'],
  ['suspended_accounts', 'overview.suspendedAccounts'],
];

const jobFields = [
  ['pending_dispatch', 'overview.jobsPendingDispatch'],
  ['active', 'overview.jobsActive'],
  ['completed', 'overview.jobsCompleted'],
  ['cancelled', 'overview.jobsCancelled'],
];

// valueText shows numbers as-is and passes non-numeric fallbacks through —
// figures reach the DOM via textContent only, never as markup.
function valueText(raw) {
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string' && raw === 'unavailable') return t('overview.unavailable');
  if (typeof raw === 'string' && raw !== '') return raw;
  return '—';
}

function isUnavailable(raw) {
  return raw === 'unavailable' || raw === undefined || raw === null;
}

function statCard(key, label, raw) {
  const card = el('div', 'stat-card');
  card.dataset.testid = `overview-${key}`;
  const h = el('h3', '', label);
  const value = el('strong', isUnavailable(raw) ? 'stat-value unavailable' : 'stat-value', valueText(raw));
  card.append(h, value);
  return card;
}

export async function loadOverview() {
  const errEl = document.getElementById('overview-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.hidden = true;
  }

  let data;
  try {
    const res = await api('/api/overview');
    if (!res.ok) throw new Error(`overview request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    if (errEl) {
      errEl.textContent = t('overview.error', { error: e.message });
      show(errEl);
    }
    return;
  }

  const grid = document.getElementById('overview-grid');
  if (!grid) return;
  grid.textContent = '';

  // A non-object payload (defensive against proxy drift) renders as empty
  // state instead of crashing the page.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const p = el('p', 'empty-state', 'No overview data.');
    grid.appendChild(p);
    return;
  }

  for (const [key, labelKey] of cards) {
    grid.appendChild(statCard(key, t(labelKey), data[key]));
  }

  const jobs = typeof data.jobs_today === 'object' && data.jobs_today !== null && !Array.isArray(data.jobs_today)
    ? data.jobs_today
    : {};

  const jobsCard = el('div', 'stat-card stat-card-wide');
  jobsCard.dataset.testid = 'overview-jobs_today';
  jobsCard.appendChild(el('h3', '', t('overview.jobGroups')));
  const rows = el('div', 'stat-rows');
  for (const [field, labelKey] of jobFields) {
    const row = el('div', 'stat-row');
    row.appendChild(el('span', '', t(labelKey)));
    row.appendChild(el('strong', isUnavailable(jobs[field]) ? 'stat-value unavailable' : 'stat-value', valueText(jobs[field])));
    rows.appendChild(row);
  }
  jobsCard.appendChild(rows);
  grid.appendChild(jobsCard);

  hide(document.getElementById('overview-loading'));
}

export function wire() {
  const refresh = document.getElementById('refresh-overview-btn');
  if (refresh) refresh.addEventListener('click', loadOverview);
}
