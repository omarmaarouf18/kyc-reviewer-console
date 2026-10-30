// Disputes & escrow reconciliation (ADR-0023): the user-service flagged-jobs
// queue and the resolve dialog with release / refund decisions.
//
// Ported onto the shared console kit (table controller, dialog kit, toasts)
// with AR/EN strings.
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide, detailRow } from '../core/dom.js';
import { num, upper } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { toast } from '../core/ui/toast.js';

addTranslations('disputes', {
  ar: {
    title: 'النزاعات والمطابقة',
    refresh: 'تحديث',
    empty: 'لا توجد مهام بانتظار مطابقة الضمان.',
    loadFailed: 'فشل تحميل قائمة النزاعات: {error}',
    col: {
      job: 'المهمة',
      service: 'الخدمة',
      distance: 'فرق المسافة',
      escrow: 'الضمان المحجوز',
      payment: 'الدفع',
      reason: 'سبب العلامة',
      action: 'إجراء',
    },
    distance: {
      tracked: '{distance} كم مقطوعة',
      booked: 'المحجوز: {booked} كم ({ratio}%)',
      waypoints: '{count} نقطة مسار',
    },
    resolve: {
      title: 'حل النزاع / المطابقة',
      target: 'نزاع على المهمة {id}',
      release: 'صرف الأموال للمندوب / التاجر',
      markCompleted: '(تحديد كمكتملة)',
      refund: 'استرداد الضمان للعميل',
      markCancelled: '(تحديد ملغاة)',
      reason: 'سبب القرار',
      submit: 'تأكيد الحل',
      close: 'إلغاء',
      required: 'سبب القرار مطلوب.',
      failed: 'فشل حل النزاع: {error}',
      done: 'تم حل النزاع.',
    },
    detail: {
      status: 'الحالة',
      service: 'الخدمة',
      distances: 'المحجوز مقابل المسافة المقطوعة',
      escrow: 'الضمان المحجوز',
      actualAmount: 'المبلغ الفعلي',
      paymentMethod: 'طريقة الدفع',
      owner: 'مالك التاجر',
      courier: 'المندوب المسؤول',
      customer: 'العميل',
      flagReason: 'سبب العلامة',
      flagNote: 'ملاحظة العلامة',
      created: 'أُنشئت',
      updated: 'آخر تحديث',
    },
  },
  en: {
    title: 'Disputes & Escrow Reconciliation',
    refresh: 'Refresh',
    empty: 'No jobs pending escrow reconciliation.',
    loadFailed: 'Failed to load the reconciliation queue: {error}',
    col: {
      job: 'Job',
      service: 'Service',
      distance: 'Distance discrepancy',
      escrow: 'Locked Escrow',
      payment: 'Payment',
      reason: 'Flag reason',
      action: 'Action',
    },
    distance: {
      tracked: '{distance} km tracked',
      booked: 'Booked: {booked} km ({ratio}%)',
      waypoints: '{count} waypoints',
    },
    resolve: {
      title: 'Resolve dispute / reconciliation',
      target: 'Dispute on Job {id}',
      release: 'Release funds to courier / tenant',
      markCompleted: '(mark completed)',
      refund: 'Refund escrow to customer',
      markCancelled: '(mark cancelled)',
      reason: 'Reason for the decision',
      submit: 'Confirm resolution',
      close: 'Cancel',
      required: 'A reason is required to resolve this dispute.',
      failed: 'Dispute resolution failed: {error}',
      done: 'The dispute was resolved.',
    },
    detail: {
      status: 'Status',
      service: 'Service',
      distances: 'Booked vs Tracked',
      escrow: 'Locked Escrow',
      actualAmount: 'Actual amount',
      paymentMethod: 'Payment Method',
      owner: 'Tenant Owner',
      courier: 'Assigned Courier',
      customer: 'Customer',
      flagReason: 'Flag Reason',
      flagNote: 'Flag Note',
      created: 'Created',
      updated: 'Updated',
    },
  },
});

export async function loadReconciliation() {
  hide(document.getElementById('reconciliation-error'));

  const st = state.reconciliationState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });

  let data;
  try {
    const res = await api(`/api/reconciliation/queue?${params.toString()}`);
    if (!res.ok) throw new Error(`reconciliation request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('reconciliation-error');
    if (err) {
      err.textContent = t('disputes.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const disputes = Array.isArray(data.disputes) ? data.disputes : [];
  st.total = data.total || 0;
  st.rows = disputes;

  const countBadge = document.getElementById('reconciliation-badge');
  if (countBadge) countBadge.textContent = `${st.total || disputes.length}`;

  const table = tableController({
    tbody: document.querySelector('#reconciliation-table tbody'),
    countText: document.getElementById('reconciliation-count'),
    pageInfo: document.getElementById('reconciliation-page-info'),
    prevBtn: document.getElementById('reconciliation-prev-btn'),
    nextBtn: document.getElementById('reconciliation-next-btn'),
  });

  table.renderRows({
    rows: disputes,
    colCount: 7,
    emptyText: t('disputes.empty'),
    renderRow: disputeRow,
  });

  table.updatePagination({ items: disputes.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'disputed jobs' });
}

function disputeRow(d) {
  const tr = document.createElement('tr');

  // Job (the user-service queue item carries no addresses or category)
  const jobTd = document.createElement('td');
  jobTd.appendChild(el('strong', '', `Job #${String(d.id).slice(-8)}`));
  jobTd.appendChild(document.createElement('br'));
  if (d.created_at) {
    jobTd.appendChild(el('span', 'muted small', new Date(d.created_at).toLocaleString()));
    jobTd.appendChild(document.createElement('br'));
  }
  jobTd.appendChild(el('code', 'id-tag', d.id));
  tr.appendChild(jobTd);

  // Service
  const serviceTd = document.createElement('td');
  serviceTd.appendChild(d.service_id ? el('code', '', d.service_id) : el('span', 'muted', '—'));
  tr.appendChild(serviceTd);

  // Distance Discrepancy
  const distTd = document.createElement('td');
  const booked = num(d.booked_distance);
  const actual = num(d.actual_distance);
  const ratio = booked > 0 ? (actual / booked) * 100 : 0;
  const distStat = el('span', ratio < 70 ? 'dist-stat warning-text' : 'dist-stat');
  distStat.appendChild(el('strong', '', `${actual.toFixed(1)} km`));
  distStat.appendChild(document.createTextNode(' '));
  distStat.appendChild(el('span', '', t('disputes.distance.tracked', { distance: actual.toFixed(1) })));
  distTd.appendChild(distStat);
  distTd.appendChild(el('br'));
  distTd.appendChild(el('span', 'muted small', t('disputes.distance.booked', { booked: booked.toFixed(1), ratio: ratio.toFixed(0) })));
  distTd.appendChild(el('br'));
  distTd.appendChild(el('span', 'muted small', t('disputes.distance.waypoints', { count: num(d.waypoints_count) })));
  tr.appendChild(distTd);

  // Locked Escrow
  const escrowTd = document.createElement('td');
  escrowTd.appendChild(el('strong', '', `${num(d.locked_escrow_amount).toFixed(2)} EGP`));
  tr.appendChild(escrowTd);

  // Payment
  const payTd = document.createElement('td');
  payTd.appendChild(badge(d.payment_method === 'cod' ? 'badge-cod' : 'badge-wallet', upper(d.payment_method, 'wallet')));
  tr.appendChild(payTd);

  // Flag Reason
  const flagTd = document.createElement('td');
  flagTd.className = 'small';
  flagTd.textContent = d.reconciliation_reason || d.reconciliation_note || 'under_distance_mismatch';
  tr.appendChild(flagTd);

  // Action
  const actionTd = document.createElement('td');
  const resolveBtn = document.createElement('button');
  resolveBtn.type = 'button';
  resolveBtn.className = 'btn-sm';
  resolveBtn.textContent = t('disputes.resolve.title');
  resolveBtn.addEventListener('click', () => openResolveDisputeDialog(d));
  actionTd.appendChild(resolveBtn);
  tr.appendChild(actionTd);

  return tr;
}

export function openResolveDisputeDialog(dispute) {
  if (!dispute) return;
  state.targetDispute = dispute;
  const target = document.getElementById('resolve-dispute-target');
  if (target) target.textContent = t('disputes.resolve.target', { id: dispute.id });

  const detailsEl = document.getElementById('resolve-dispute-details');
  const booked = num(dispute.booked_distance);
  const actual = num(dispute.actual_distance);
  const ratio = booked > 0 ? ((actual / booked) * 100).toFixed(0) : '0';
  detailsEl.textContent = '';
  // Only fields the user-service queue item actually carries are shown; a
  // row is omitted when its value is absent rather than rendered as
  // "undefined" or a made-up default.
  const rows = [
    [t('disputes.detail.status'), dispute.status, 'code'],
    [t('disputes.detail.service'), dispute.service_id, 'code'],
    [t('disputes.detail.distances'), `${booked.toFixed(1)} km vs ${actual.toFixed(1)} km (${ratio}%), ${num(dispute.waypoints_count)} waypoints`],
    [t('disputes.detail.escrow'), `${num(dispute.locked_escrow_amount).toFixed(2)} EGP`],
    [t('disputes.detail.actualAmount'), dispute.actual_amount ? `${num(dispute.actual_amount).toFixed(2)} EGP` : null],
    [t('disputes.detail.paymentMethod'), dispute.payment_method ? upper(dispute.payment_method) : null],
    [t('disputes.detail.owner'), dispute.owner_id, 'code'],
    [t('disputes.detail.courier'), dispute.employee_id, 'code'],
    [t('disputes.detail.customer'), dispute.customer_id, 'code'],
    [t('disputes.detail.flagReason'), dispute.reconciliation_reason, 'em'],
    [t('disputes.detail.flagNote'), dispute.reconciliation_note, 'em'],
    [t('disputes.detail.created'), dispute.created_at ? new Date(dispute.created_at).toLocaleString() : null, 'span'],
    [t('disputes.detail.updated'), dispute.updated_at ? new Date(dispute.updated_at).toLocaleString() : null, 'span'],
  ];
  for (const [label, value, tag] of rows) {
    if (value !== undefined && value !== null && value !== '') detailsEl.appendChild(detailRow(label, value, tag));
  }

  const reason = document.getElementById('resolve-dispute-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('resolve-dispute-error'));
  const defaultRadio = document.querySelector('input[name="dispute-decision"][value="release_to_employee"]');
  if (defaultRadio) defaultRadio.checked = true;

  openDialog('resolve-dispute-dialog');
}

export async function submitResolveDispute() {
  if (!state.targetDispute) return;
  const radio = document.querySelector('input[name="dispute-decision"]:checked');
  const decision = radio ? radio.value : 'release_to_employee';
  const reasonEl = document.getElementById('resolve-dispute-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';

  if (!reason) {
    const err = document.getElementById('resolve-dispute-error');
    if (err) {
      err.textContent = t('disputes.resolve.required');
      show(err);
    }
    return;
  }

  try {
    const res = await api('/api/reconciliation/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: state.targetDispute.id,
        decision,
        reason,
      }),
    });

    if (!res.ok) {
      let msg = `Dispute resolution failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('resolve-dispute-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    closeDialog('resolve-dispute-dialog');
    state.targetDispute = null;
    toast(t('disputes.resolve.done'), 'ok');
    loadReconciliation();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const msg = t('disputes.resolve.failed', { error: e.message || 'Network error' });
    const err = document.getElementById('resolve-dispute-error');
    if (err) {
      err.textContent = msg;
      show(err);
    } else {
      alert(msg);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-reconciliation-btn');
  if (refresh) refresh.addEventListener('click', loadReconciliation);

  const prev = document.getElementById('reconciliation-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.reconciliationState, -1, loadReconciliation));
  const next = document.getElementById('reconciliation-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.reconciliationState, +1, loadReconciliation));

  const cancelBtn = document.getElementById('resolve-dispute-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog('resolve-dispute-dialog'));
  const submitBtn = document.getElementById('resolve-dispute-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitResolveDispute);
}
