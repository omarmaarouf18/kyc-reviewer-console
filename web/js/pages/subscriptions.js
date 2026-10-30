// Subscriptions management (ADR-0023 Module A): tenant tiers, plan activation
// with duration, revocation with mandatory reason.

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide } from '../core/dom.js';
import { upper } from '../core/format.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';

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
    err.textContent = `Failed to load subscriptions: ${e.message}`;
    show(err);
    return;
  }

  const subs = data.subscriptions || [];
  st.total = data.total || 0;

  const countBadge = document.getElementById('subscriptions-badge');
  if (countBadge) countBadge.textContent = `${data.total || subs.length}`;

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
    emptyText: 'No subscriptions found.',
    renderRow: subscriptionRow,
  });

  table.updatePagination({ items: subs.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'subscriptions' });
}

function subscriptionRow(s) {
  const tr = document.createElement('tr');

  // Tenant ID
  const tenantTd = document.createElement('td');
  tenantTd.appendChild(el('strong', '', s.tenant_id));
  tenantTd.appendChild(el('br'));
  tenantTd.appendChild(el('code', 'id-tag', s.id || ''));
  tr.appendChild(tenantTd);

  // Tier Status
  const tierTd = document.createElement('td');
  let badgeClass = 'badge-free';
  if (s.tier === 'paid') badgeClass = 'badge-paid';
  else if (s.tier === 'pending_payment') badgeClass = 'badge-pending';
  else if (s.tier === 'cancelled') badgeClass = 'badge-cancelled';
  tierTd.appendChild(badge(badgeClass, upper(s.tier, 'free')));
  tr.appendChild(tierTd);

  // Started At
  const startedTd = document.createElement('td');
  startedTd.textContent = s.started_at ? new Date(s.started_at).toLocaleDateString() : '—';
  tr.appendChild(startedTd);

  // Expires At
  const expiresTd = document.createElement('td');
  expiresTd.textContent = s.expires_at ? new Date(s.expires_at).toLocaleDateString() : 'No expiry (Free)';
  tr.appendChild(expiresTd);

  // Audit Notes
  const notesTd = document.createElement('td');
  notesTd.className = 'small';
  for (const [label, who] of [['Activated by', s.activated_by], ['Revoked by', s.revoked_by]]) {
    if (!who) continue;
    notesTd.appendChild(el('span', 'muted', `${label}:`));
    notesTd.appendChild(document.createTextNode(' '));
    notesTd.appendChild(el('code', '', who));
    notesTd.appendChild(el('br'));
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
    actBtn.textContent = 'Activate Plan…';
    actBtn.addEventListener('click', () => openActivateSubDialog(s));
    actionTd.appendChild(actBtn);
  }
  if (s.tier === 'paid' || s.tier === 'pending_payment') {
    const revBtn = document.createElement('button');
    revBtn.type = 'button';
    revBtn.className = 'btn-sm danger';
    revBtn.textContent = 'Revoke…';
    revBtn.style.marginLeft = '0.35rem';
    revBtn.addEventListener('click', () => openRevokeSubDialog(s));
    actionTd.appendChild(revBtn);
  }
  tr.appendChild(actionTd);

  return tr;
}

export function openActivateSubDialog(sub) {
  state.targetSub = sub;
  document.getElementById('activate-sub-target').textContent = `Tenant: ${sub.tenant_id} (Current: ${(sub.tier || 'free').toUpperCase()})`;
  hide(document.getElementById('activate-sub-error'));
  openDialog('activate-sub-dialog');
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
        subscription_id: state.targetSub.id,
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
    loadSubscriptions();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('activate-sub-error');
    if (err) {
      err.textContent = `Activation failed: ${e.message || 'Network error'}`;
      show(err);
    } else {
      alert(`Activation failed: ${e.message || 'Network error'}`);
    }
  }
}

export function openRevokeSubDialog(sub) {
  state.targetSub = sub;
  document.getElementById('revoke-sub-target').textContent = `Tenant: ${sub.tenant_id} (Active Plan)`;
  document.getElementById('revoke-sub-reason').value = '';
  hide(document.getElementById('revoke-sub-error'));
  openDialog('revoke-sub-dialog');
}

export async function submitRevokeSub() {
  if (!state.targetSub) return;
  const reason = document.getElementById('revoke-sub-reason').value.trim();
  if (!reason) {
    const err = document.getElementById('revoke-sub-error');
    err.textContent = 'A reason is required to revoke a subscription.';
    show(err);
    return;
  }

  try {
    const res = await api('/api/subscriptions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.targetSub.tenant_id,
        subscription_id: state.targetSub.id,
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
      err.textContent = msg;
      show(err);
      return;
    }

    closeDialog('revoke-sub-dialog');
    loadSubscriptions();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('revoke-sub-error');
    if (err) {
      err.textContent = `Revocation failed: ${e.message || 'Network error'}`;
      show(err);
    } else {
      alert(`Revocation failed: ${e.message || 'Network error'}`);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-subscriptions-btn');
  if (refresh) refresh.addEventListener('click', loadSubscriptions);

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
