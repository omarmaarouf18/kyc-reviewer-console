// Payout requests: tenant payout list with status filter and rejection with
// a mandatory reason (1-1000 chars).

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide } from '../core/dom.js';
import { num, upper } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { toast } from '../core/ui/toast.js';

addTranslations('payouts', {
  ar: {
    title: 'طلبات صرف الأرباح',
    refresh: 'تحديث',
    filter: 'بحث',
    reset: 'مسح',
    empty: 'لا توجد طلبات صرف.',
    loadFailed: 'فشل تحميل طلبات الصرف: {error}',
    col: {
      id: 'معرف الطلب',
      tenant: 'معرف التاجر',
      amount: 'المبلغ',
      method: 'الطريقة',
      status: 'الحالة',
      created: 'تاريخ الطلب',
      action: 'إجراء',
    },
    reject: 'رفض…',
    rejectedReason: 'السبب: {reason}',
    rejectDialog: {
      title: 'رفض طلب الصرف',
      target: 'طلب {id} • تاجر {tenant} • {amount} EGP',
      reason: 'سبب الرفض',
      submit: 'تأكيد الرفض',
      close: 'إلغاء',
      required: 'سبب الرفض مطلوب.',
      tooLong: 'السبب يتجاوز الحد الأقصى (1000 حرف).',
      failed: 'فشل رفض طلب الصرف: {error}',
      done: 'تم رفض طلب الصرف.',
    },
  },
  en: {
    title: 'Tenant payout requests',
    refresh: 'Refresh',
    filter: 'Filter',
    reset: 'Reset',
    empty: 'No payout requests found.',
    loadFailed: 'Failed to load payouts: {error}',
    col: {
      id: 'Payout ID',
      tenant: 'Tenant ID',
      amount: 'Amount',
      method: 'Method',
      status: 'Status',
      created: 'Requested at',
      action: 'Action',
    },
    reject: 'Reject…',
    rejectedReason: 'Reason: {reason}',
    rejectDialog: {
      title: 'Reject payout request',
      target: 'Payout {id} • Tenant {tenant} • {amount} EGP',
      reason: 'Reason for rejection',
      submit: 'Confirm rejection',
      close: 'Cancel',
      required: 'A reason is required for rejection.',
      tooLong: 'The reason exceeds the maximum length of 1000 characters.',
      failed: 'Failed to reject the payout: {error}',
      done: 'The payout request was rejected.',
    },
  },
});

export async function loadPayouts() {
  const st = state.payoutsState;
  const params = new URLSearchParams();
  if (st.status) params.set('status', st.status);
  params.set('page', st.page);
  params.set('limit', st.limit);

  let data;
  try {
    const res = await api(`/api/payouts?${params.toString()}`);
    if (!res.ok) throw new Error(`payouts request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('payouts-error');
    if (err) {
      err.textContent = t('payouts.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const payouts = Array.isArray(data.payouts) ? data.payouts : [];
  st.total = data.total || 0;
  st.rows = payouts;

  const countBadge = document.getElementById('payouts-badge');
  if (countBadge) countBadge.textContent = `${data.total || payouts.length}`;

  const table = tableController({
    tbody: document.querySelector('#payouts-table tbody'),
    countText: document.getElementById('payouts-count'),
    pageInfo: document.getElementById('payouts-page-info'),
    prevBtn: document.getElementById('payouts-prev-btn'),
    nextBtn: document.getElementById('payouts-next-btn'),
  });

  table.renderRows({
    rows: payouts,
    colCount: 7,
    emptyText: t('payouts.empty'),
    renderRow: payoutRow,
  });

  table.updatePagination({ items: payouts.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'requests' });

  hide(document.getElementById('payouts-error'));
}

function payoutRow(p) {
  const tr = document.createElement('tr');

  // Payout ID
  const idTd = document.createElement('td');
  idTd.appendChild(el('code', 'id-tag', p.id || ''));
  tr.appendChild(idTd);

  // Tenant ID
  const tenantTd = document.createElement('td');
  tenantTd.appendChild(el('strong', '', p.tenant_id));
  tr.appendChild(tenantTd);

  // Amount
  const amountTd = document.createElement('td');
  amountTd.appendChild(el('strong', '', `${num(p.amount).toFixed(2)} EGP`));
  tr.appendChild(amountTd);

  // Method
  const methodTd = document.createElement('td');
  methodTd.textContent = p.payout_method || '—';
  tr.appendChild(methodTd);

  // Status
  const statusTd = document.createElement('td');
  let badgeClass = 'badge-pending';
  if (p.status === 'paid' || p.status === 'approved') badgeClass = 'badge-paid';
  else if (p.status === 'rejected') badgeClass = 'badge-cancelled';
  statusTd.appendChild(badge(badgeClass, upper(p.status, 'requested')));
  tr.appendChild(statusTd);

  // Requested At
  const dateTd = document.createElement('td');
  dateTd.textContent = p.created_at ? new Date(p.created_at).toLocaleString() : '—';
  tr.appendChild(dateTd);

  // Action / Notes
  const actionTd = document.createElement('td');
  if (p.status === 'requested') {
    const rejBtn = document.createElement('button');
    rejBtn.type = 'button';
    rejBtn.className = 'btn-sm danger';
    rejBtn.textContent = t('payouts.reject');
    rejBtn.addEventListener('click', () => openRejectPayoutDialog(p));
    actionTd.appendChild(rejBtn);
  } else if (p.status === 'rejected' && p.rejection_reason) {
    actionTd.className = 'small';
    actionTd.appendChild(el('em', '', t('payouts.rejectedReason', { reason: p.rejection_reason })));
  } else {
    actionTd.textContent = '—';
  }
  tr.appendChild(actionTd);

  return tr;
}

export function openRejectPayoutDialog(payout) {
  state.activeRejectPayout = payout;
  const target = document.getElementById('reject-payout-target');
  if (target) {
    target.textContent = t('payouts.rejectDialog.target', {
      id: payout.id,
      tenant: payout.tenant_id,
      amount: num(payout.amount).toFixed(2),
    });
  }
  const reason = document.getElementById('reject-payout-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('reject-payout-error'));
  openDialog('reject-payout-modal');
}

export async function submitRejectPayout() {
  if (!state.activeRejectPayout) return;
  const reason = document.getElementById('reject-payout-reason').value.trim();
  const errEl = document.getElementById('reject-payout-error');

  if (!reason) {
    errEl.textContent = t('payouts.rejectDialog.required');
    show(errEl);
    return;
  }
  if (reason.length > 1000) {
    errEl.textContent = t('payouts.rejectDialog.tooLong');
    show(errEl);
    return;
  }

  const submitBtn = document.getElementById('reject-payout-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = `${t('payouts.rejectDialog.submit')}…`;

  try {
    const res = await api('/api/payouts/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payout_id: state.activeRejectPayout.id,
        reason,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    closeDialog('reject-payout-modal');
    state.activeRejectPayout = null;
    toast(t('payouts.rejectDialog.done'), 'ok');
    loadPayouts();
  } catch (err) {
    if (isUnauthorized(err)) return;
    errEl.textContent = t('payouts.rejectDialog.failed', { error: err.message });
    show(errEl);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = t('payouts.rejectDialog.submit');
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-payouts-btn');
  if (refresh) refresh.addEventListener('click', loadPayouts);

  const form = document.getElementById('payouts-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFilters();
    });
  }
  const reset = document.getElementById('payouts-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('payouts-status-filter').value = '';
    applyFilters();
  });

  const prev = document.getElementById('payouts-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.payoutsState, -1, loadPayouts));
  const next = document.getElementById('payouts-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.payoutsState, +1, loadPayouts));

  const cancelBtn = document.getElementById('reject-payout-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog('reject-payout-modal'));
  const submitBtn = document.getElementById('reject-payout-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitRejectPayout);
}

function applyFilters() {
  const st = state.payoutsState;
  st.status = document.getElementById('payouts-status-filter').value;
  st.page = 1;
  loadPayouts();
}
