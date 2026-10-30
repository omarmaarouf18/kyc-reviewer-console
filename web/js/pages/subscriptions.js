// Subscriptions management (ADMIN_API § 5, ADR-0023 Module A).
//
// Queue-first: the page opens on the pending upgrade requests (offline bank
// transfer / cash collection awaiting manual verification, oldest first) and
// the reviewer activates them from there. The second view lists every
// subscription with its tier, expiry and audit trail.
//
// Activation contract (user-service): POST /admin/subscriptions/activate with
// { tenant_id, subscription_id, duration_days }. The queue item carries the
// subscription id in `subscription_id`.
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide } from '../core/dom.js';
import { upper } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';

addTranslations('subscriptions', {
  ar: {
    title: 'الاشتراكات',
    refresh: 'تحديث',
    filter: 'بحث',
    reset: 'مسح',
    view: {
      queue: 'قائمة الترقية',
      all: 'كل الاشتراكات',
    },
    queue: {
      empty: 'لا توجد طلبات ترقية بانتظار التحقق.',
      loadFailed: 'فشل تحميل قائمة الترقية: {error}',
      col: {
        tenant: 'التاجر',
        plan: 'الخطة المطلوبة',
        requested: 'تاريخ الطلب',
        contact: 'صاحب الحساب',
        action: 'إجراء',
      },
      owner: 'المالك',
      activate: 'تفعيل…',
    },
    col: {
      tenant: 'معرف التاجر',
      tier: 'حالة الباقة',
      started: 'بدأت',
      expires: 'تنتهي',
      notes: 'ملاحظات التدقيق',
      action: 'إجراء',
    },
    empty: 'لا توجد اشتراكات.',
    loadFailed: 'فشل تحميل الاشتراكات: {error}',
    tier: {
      paid: 'مدفوعة',
      pending_payment: 'بانتظار الدفع',
      free: 'مجانية',
      cancelled: 'ملغاة',
    },
    activatedBy: 'فعّلها',
    revokedBy: 'ألغاها',
    noExpiry: 'لا تنتهي (مجانية)',
    activate: {
      title: 'تفعيل الباقة المدفوعة',
      target: 'التاجر: {tenant} (الحالية: {tier})',
      info: 'Confirm manual offline payment or bank invoice verification before activation.',
      duration: 'مدة الباقة',
      submit: 'تفعيل الباقة',
      close: 'إلغاء',
      failed: 'فشل التفعيل: {error}',
    },
    revoke: {
      title: 'إلغاء الاشتراك',
      target: 'التاجر: {tenant} (الباقة النشطة)',
      reason: 'سبب الإلغاء',
      submit: 'تأكيد الإلغاء',
      close: 'إلغاء',
      required: 'سبب الإلغاء مطلوب.',
      failed: 'فشل الإلغاء: {error}',
    },
  },
  en: {
    title: 'Subscriptions',
    refresh: 'Refresh',
    filter: 'Filter',
    reset: 'Reset',
    view: {
      queue: 'Upgrade queue',
      all: 'All subscriptions',
    },
    queue: {
      empty: 'No upgrade requests awaiting verification.',
      loadFailed: 'Failed to load the upgrade queue: {error}',
      col: {
        tenant: 'Tenant',
        plan: 'Requested plan',
        requested: 'Requested at',
        contact: 'Owner contact',
        action: 'Action',
      },
      owner: 'Owner',
      activate: 'Activate…',
    },
    col: {
      tenant: 'Tenant ID',
      tier: 'Tier status',
      started: 'Started at',
      expires: 'Expires at',
      notes: 'Audit notes',
      action: 'Action',
    },
    empty: 'No subscriptions found.',
    loadFailed: 'Failed to load subscriptions: {error}',
    tier: {
      paid: 'Paid',
      pending_payment: 'Pending payment',
      free: 'Free',
      cancelled: 'Cancelled',
    },
    activatedBy: 'Activated by',
    revokedBy: 'Revoked by',
    noExpiry: 'No expiry (Free)',
    activate: {
      title: 'Activate tenant paid tier',
      target: 'Tenant: {tenant} (Current: {tier})',
      info: 'Confirm manual offline payment or bank invoice verification before activation.',
      duration: 'Plan duration',
      submit: 'Activate plan',
      close: 'Cancel',
      failed: 'Activation failed: {error}',
    },
    revoke: {
      title: 'Revoke subscription plan',
      target: 'Tenant: {tenant} (Active plan)',
      reason: 'Revocation reason',
      submit: 'Confirm revocation',
      close: 'Cancel',
      required: 'A reason is required to revoke a subscription.',
      failed: 'Revocation failed: {error}',
    },
  },
});

// Tier badge classes come from a fixed map, never from the API value.
const TIER_BADGES = {
  paid: 'badge-paid',
  pending_payment: 'badge-pending',
  free: 'badge-free',
  cancelled: 'badge-cancelled',
};

// loadSubscriptionQueue loads the pending upgrade requests (the default view
// of the subscriptions page) and refreshes the nav badge from it.
export async function loadSubscriptionQueue() {
  hide(document.getElementById('subscriptions-queue-error'));
  const st = state.subscriptionsQueueState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });

  let data;
  try {
    const res = await api(`/api/subscriptions/queue?${params.toString()}`);
    if (!res.ok) throw new Error(`subscription queue request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('subscriptions-queue-error');
    if (err) {
      err.textContent = t('subscriptions.queue.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const queue = Array.isArray(data.queue)
    ? data.queue
    : (Array.isArray(data.subscriptions) ? data.subscriptions : []);
  st.total = data.total || queue.length;
  st.rows = queue;

  // The nav badge counts the requests awaiting verification.
  const countBadge = document.getElementById('subscriptions-badge');
  if (countBadge) countBadge.textContent = `${st.total}`;

  const table = tableController({
    tbody: document.querySelector('#subscriptions-queue-table tbody'),
    countText: document.getElementById('subscriptions-queue-count'),
    pageInfo: document.getElementById('subscriptions-queue-page-info'),
    prevBtn: document.getElementById('subscriptions-queue-prev-btn'),
    nextBtn: document.getElementById('subscriptions-queue-next-btn'),
  });

  table.renderRows({
    rows: queue,
    colCount: 5,
    emptyText: t('subscriptions.queue.empty'),
    renderRow: subscriptionQueueRow,
  });

  table.updatePagination({ items: queue.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'requests' });
}

// subscriptionQueueRow renders one pending upgrade request.
function subscriptionQueueRow(s) {
  const tr = document.createElement('tr');

  const tenantTd = document.createElement('td');
  tenantTd.appendChild(el('strong', '', s.tenant_name || s.tenant_id || '—'));
  tenantTd.appendChild(document.createElement('br'));
  tenantTd.appendChild(el('code', 'id-tag', s.tenant_id || ''));
  tr.appendChild(tenantTd);

  const planTd = document.createElement('td');
  planTd.appendChild(badge(TIER_BADGES[s.tier] || 'badge-free', upper(s.requested_plan || s.tier, 'free')));
  if (s.status) {
    planTd.appendChild(document.createElement('br'));
    planTd.appendChild(el('span', 'muted small', s.status));
  }
  tr.appendChild(planTd);

  const requestedTd = document.createElement('td');
  requestedTd.className = 'muted small';
  requestedTd.textContent = s.requested_at ? new Date(s.requested_at).toLocaleString() : '—';
  tr.appendChild(requestedTd);

  const contactTd = document.createElement('td');
  const contact = s.owner_contact || {};
  if (contact.name) contactTd.appendChild(el('strong', '', contact.name));
  if (contact.company_name && contact.company_name !== s.tenant_name) {
    if (contact.name) contactTd.appendChild(document.createElement('br'));
    contactTd.appendChild(el('span', 'muted small', contact.company_name));
  }
  if (contact.username) {
    if (contactTd.childNodes.length) contactTd.appendChild(document.createElement('br'));
    contactTd.appendChild(el('span', '', `@${contact.username}`));
  }
  if (contact.email) {
    if (contactTd.childNodes.length) contactTd.appendChild(document.createElement('br'));
    contactTd.appendChild(el('span', 'muted small', contact.email));
  }
  if (contact.phone) {
    if (contactTd.childNodes.length) contactTd.appendChild(document.createElement('br'));
    contactTd.appendChild(el('code', 'id-tag', contact.phone));
  }
  if (!contactTd.childNodes.length) contactTd.appendChild(el('span', 'muted', '—'));
  tr.appendChild(contactTd);

  const actionTd = document.createElement('td');
  const activateBtn = document.createElement('button');
  activateBtn.type = 'button';
  activateBtn.className = 'btn-sm';
  activateBtn.textContent = t('subscriptions.queue.activate');
  activateBtn.addEventListener('click', () => openActivateSubDialog(s));
  actionTd.appendChild(activateBtn);
  tr.appendChild(actionTd);

  return tr;
}

// showSubscriptionsView switches between the upgrade queue (default) and the
// full subscription list.
export function showSubscriptionsView(view) {
  state.subscriptionsState.view = view === 'all' ? 'all' : 'queue';
  const isQueue = state.subscriptionsState.view === 'queue';

  const queueBtn = document.getElementById('subscriptions-view-queue');
  const allBtn = document.getElementById('subscriptions-view-all');
  if (queueBtn) {
    queueBtn.classList.toggle('is-active', isQueue);
    queueBtn.setAttribute('aria-selected', isQueue ? 'true' : 'false');
  }
  if (allBtn) {
    allBtn.classList.toggle('is-active', !isQueue);
    allBtn.setAttribute('aria-selected', isQueue ? 'false' : 'true');
  }

  if (isQueue) {
    show(document.getElementById('subscriptions-queue-view'));
    hide(document.getElementById('subscriptions-all-view'));
  } else {
    hide(document.getElementById('subscriptions-queue-view'));
    show(document.getElementById('subscriptions-all-view'));
  }

  if (isQueue) loadSubscriptionQueue();
  else loadSubscriptions();
}

// loadSubscriptions loads every subscription (tiers, expiry, audit trail).
export async function loadSubscriptions() {
  hide(document.getElementById('subscriptions-error'));
  const st = state.subscriptionsState;
  const params = new URLSearchParams();
  if (st.status) params.set('status', st.status);
  if (st.search) params.set('search', st.search);
  params.set('page', st.page);
  params.set('limit', st.limit);

  let data;
  try {
    const res = await api(`/api/subscriptions?${params.toString()}`);
    if (!res.ok) throw new Error(`subscriptions request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('subscriptions-error');
    if (err) {
      err.textContent = t('subscriptions.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const subs = data.subscriptions || [];
  st.total = data.total || 0;
  st.rows = subs;

  const table = tableController({
    tbody: document.querySelector('#subscriptions-table tbody'),
    countText: document.getElementById('subscriptions-count'),
    pageInfo: document.getElementById('subscriptions-page-info'),
    prevBtn: document.getElementById('subscriptions-prev-btn'),
    nextBtn: document.getElementById('subscriptions-next-btn'),
  });

  table.renderRows({
    rows: subs,
    colCount: 6,
    emptyText: t('subscriptions.empty'),
    renderRow: subscriptionRow,
  });

  table.updatePagination({ items: subs.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'subscriptions' });
}

function subscriptionRow(s) {
  const tr = document.createElement('tr');

  // Tenant ID
  const tenantTd = document.createElement('td');
  tenantTd.appendChild(el('strong', '', s.tenant_id || '—'));
  tenantTd.appendChild(document.createElement('br'));
  tenantTd.appendChild(el('code', 'id-tag', s.id || ''));
  tr.appendChild(tenantTd);

  // Tier Status
  const tierTd = document.createElement('td');
  tierTd.appendChild(badge(TIER_BADGES[s.tier] || 'badge-free', upper(s.tier, 'free')));
  tr.appendChild(tierTd);

  // Started At
  const startedTd = document.createElement('td');
  startedTd.textContent = s.started_at ? new Date(s.started_at).toLocaleDateString() : '—';
  tr.appendChild(startedTd);

  // Expires At
  const expiresTd = document.createElement('td');
  expiresTd.textContent = s.expires_at ? new Date(s.expires_at).toLocaleDateString() : t('subscriptions.noExpiry');
  tr.appendChild(expiresTd);

  // Audit Notes
  const notesTd = document.createElement('td');
  notesTd.className = 'small';
  for (const [label, who] of [[t('subscriptions.activatedBy'), s.activated_by], [t('subscriptions.revokedBy'), s.revoked_by]]) {
    if (!who) continue;
    notesTd.appendChild(el('span', 'muted', `${label}:`));
    notesTd.appendChild(document.createTextNode(' '));
    notesTd.appendChild(el('code', '', who));
    notesTd.appendChild(document.createElement('br'));
  }
  if (s.reason) notesTd.appendChild(el('em', '', s.reason));
  if (!s.activated_by && !s.revoked_by && !s.reason) notesTd.textContent = '—';
  tr.appendChild(notesTd);

  // Action
  const actionTd = document.createElement('td');
  if (s.tier === 'pending_payment' || s.tier === 'free' || s.tier === 'cancelled') {
    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'btn-sm';
    actBtn.textContent = t('subscriptions.activate.submit');
    actBtn.addEventListener('click', () => openActivateSubDialog(s));
    actionTd.appendChild(actBtn);
  }
  if (s.tier === 'paid' || s.tier === 'pending_payment') {
    const revBtn = document.createElement('button');
    revBtn.type = 'button';
    revBtn.className = 'btn-sm danger';
    revBtn.textContent = t('subscriptions.revoke.submit');
    revBtn.style.marginLeft = '0.35rem';
    revBtn.addEventListener('click', () => openRevokeSubDialog(s));
    actionTd.appendChild(revBtn);
  }
  tr.appendChild(actionTd);

  return tr;
}

// openActivateSubDialog opens the activation dialog for a queue item or a
// subscription row.
export function openActivateSubDialog(sub) {
  if (!sub) return;
  state.targetSub = sub;
  const target = document.getElementById('activate-sub-target');
  if (target) {
    target.textContent = t('subscriptions.activate.target', {
      tenant: sub.tenant_name || sub.tenant_id || '',
      tier: (sub.tier || 'free').toUpperCase(),
    });
  }
  hide(document.getElementById('activate-sub-error'));
  openDialog('activate-sub-dialog');
}

// subscriptionIDOf returns the subscription id of a queue item or a
// subscription row (the queue carries it in `subscription_id`).
function subscriptionIDOf(sub) {
  return sub.subscription_id || sub.id || '';
}

export async function submitActivateSub() {
  if (!state.targetSub) return;
  const durationDays = parseInt(document.getElementById('activate-sub-duration').value, 10) || 30;

  try {
    const res = await api('/api/subscriptions/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.targetSub.tenant_id,
        subscription_id: subscriptionIDOf(state.targetSub),
        duration_days: durationDays,
      }),
    });

    if (!res.ok) {
      let msg = `Activation failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('activate-sub-error');
      err.textContent = msg;
      show(err);
      return;
    }

    closeDialog('activate-sub-dialog');
    state.targetSub = null;
    loadSubscriptionQueue();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('activate-sub-error');
    if (err) {
      err.textContent = t('subscriptions.activate.failed', { error: e.message || 'Network error' });
      show(err);
    } else {
      alert(t('subscriptions.activate.failed', { error: e.message || 'Network error' }));
    }
  }
}

export function openRevokeSubDialog(sub) {
  if (!sub) return;
  state.targetSub = sub;
  const target = document.getElementById('revoke-sub-target');
  if (target) target.textContent = t('subscriptions.revoke.target', { tenant: sub.tenant_id || '' });
  const reason = document.getElementById('revoke-sub-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('revoke-sub-error'));
  openDialog('revoke-sub-dialog');
}

export async function submitRevokeSub() {
  if (!state.targetSub) return;
  const reasonEl = document.getElementById('revoke-sub-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    const err = document.getElementById('revoke-sub-error');
    if (err) {
      err.textContent = t('subscriptions.revoke.required');
      show(err);
    }
    return;
  }

  try {
    const res = await api('/api/subscriptions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.targetSub.tenant_id,
        subscription_id: subscriptionIDOf(state.targetSub),
        reason,
      }),
    });

    if (!res.ok) {
      let msg = `Revocation failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('revoke-sub-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    closeDialog('revoke-sub-dialog');
    state.targetSub = null;
    loadSubscriptions();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('revoke-sub-error');
    if (err) {
      err.textContent = t('subscriptions.revoke.failed', { error: e.message || 'Network error' });
      show(err);
    } else {
      alert(t('subscriptions.revoke.failed', { error: e.message || 'Network error' }));
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-subscriptions-btn');
  if (refresh) {
    refresh.addEventListener('click', () => {
      if (state.subscriptionsState.view === 'all') loadSubscriptions();
      else loadSubscriptionQueue();
    });
  }

  const queueBtn = document.getElementById('subscriptions-view-queue');
  if (queueBtn) queueBtn.addEventListener('click', () => showSubscriptionsView('queue'));
  const allBtn = document.getElementById('subscriptions-view-all');
  if (allBtn) allBtn.addEventListener('click', () => showSubscriptionsView('all'));

  const form = document.getElementById('subscriptions-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFilters();
    });
  }
  const reset = document.getElementById('subscriptions-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('subscriptions-search-input').value = '';
    document.getElementById('subscriptions-status-filter').value = '';
    applyFilters();
  });

  const prev = document.getElementById('subscriptions-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.subscriptionsState, -1, loadSubscriptions));
  const next = document.getElementById('subscriptions-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.subscriptionsState, +1, loadSubscriptions));

  const queuePrev = document.getElementById('subscriptions-queue-prev-btn');
  if (queuePrev) queuePrev.addEventListener('click', () => changePage(state.subscriptionsQueueState, -1, loadSubscriptionQueue));
  const queueNext = document.getElementById('subscriptions-queue-next-btn');
  if (queueNext) queueNext.addEventListener('click', () => changePage(state.subscriptionsQueueState, +1, loadSubscriptionQueue));

  const activateCancel = document.getElementById('activate-sub-cancel');
  if (activateCancel) activateCancel.addEventListener('click', () => closeDialog('activate-sub-dialog'));
  const activateSubmit = document.getElementById('activate-sub-submit');
  if (activateSubmit) activateSubmit.addEventListener('click', submitActivateSub);

  const revokeCancel = document.getElementById('revoke-sub-cancel');
  if (revokeCancel) revokeCancel.addEventListener('click', () => closeDialog('revoke-sub-dialog'));
  const revokeSubmit = document.getElementById('revoke-sub-submit');
  if (revokeSubmit) revokeSubmit.addEventListener('click', submitRevokeSub);
}

function applyFilters() {
  const st = state.subscriptionsState;
  st.search = document.getElementById('subscriptions-search-input').value.trim();
  st.status = document.getElementById('subscriptions-status-filter').value;
  st.page = 1;
  loadSubscriptions();
}
