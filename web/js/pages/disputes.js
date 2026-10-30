// Disputes & escrow reconciliation (ADR-0023): the user-service flagged-jobs
// queue and the resolve dialog with release / refund decisions.

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide, detailRow } from '../core/dom.js';
import { num, upper } from '../core/format.js';
import state from '../core/state.js';
import { tableController } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';

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
    err.textContent = `Failed to load reconciliation queue: ${e.message}`;
    show(err);
    return;
  }

  const disputes = data.disputes || [];
  st.total = data.total || 0;

  const countBadge = document.getElementById('reconciliation-badge');
  if (countBadge) countBadge.textContent = `${data.total || disputes.length}`;

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
    emptyText: 'No jobs pending escrow reconciliation.',
    renderRow: disputeRow,
  });

  table.updatePagination({ items: disputes.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'disputed jobs' });
}

function disputeRow(d) {
  const tr = document.createElement('tr');

  // Job (the user-service queue item carries no addresses or category)
  const jobTd = document.createElement('td');
  jobTd.appendChild(el('strong', '', `Job #${String(d.id).slice(-8)}`));
  jobTd.appendChild(el('br'));
  if (d.created_at) {
    jobTd.appendChild(el('span', 'muted small', new Date(d.created_at).toLocaleString()));
    jobTd.appendChild(el('br'));
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
  distStat.appendChild(document.createTextNode(' tracked'));
  distTd.appendChild(distStat);
  distTd.appendChild(el('br'));
  distTd.appendChild(el('span', 'muted small', `Booked: ${booked.toFixed(1)} km (${ratio.toFixed(0)}%)`));
  distTd.appendChild(el('br'));
  distTd.appendChild(el('span', 'muted small', `${num(d.waypoints_count)} waypoints`));
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
  resolveBtn.textContent = 'Resolve Dispute…';
  resolveBtn.addEventListener('click', () => openResolveDisputeDialog(d));
  actionTd.appendChild(resolveBtn);
  tr.appendChild(actionTd);

  return tr;
}

export function openResolveDisputeDialog(dispute) {
  state.targetDispute = dispute;
  document.getElementById('resolve-dispute-target').textContent =
    `Dispute on Job ${dispute.id}`;

  const detailsEl = document.getElementById('resolve-dispute-details');
  const booked = num(dispute.booked_distance);
  const actual = num(dispute.actual_distance);
  const ratio = booked > 0 ? ((actual / booked) * 100).toFixed(0) : '0';
  detailsEl.textContent = '';
  // Only fields the user-service queue item actually carries are shown; a
  // row is omitted when its value is absent rather than rendered as
  // "undefined" or a made-up default.
  const rows = [
    ['Status', dispute.status, 'code'],
    ['Service', dispute.service_id, 'code'],
    ['Booked vs Tracked', `${booked.toFixed(1)} km vs ${actual.toFixed(1)} km (${ratio}%), ${num(dispute.waypoints_count)} waypoints`],
    ['Locked Escrow', `${num(dispute.locked_escrow_amount).toFixed(2)} EGP`],
    ['Actual Amount', dispute.actual_amount ? `${num(dispute.actual_amount).toFixed(2)} EGP` : null],
    ['Payment Method', dispute.payment_method ? upper(dispute.payment_method) : null],
    ['Tenant Owner', dispute.owner_id, 'code'],
    ['Assigned Courier', dispute.employee_id, 'code'],
    ['Customer', dispute.customer_id, 'code'],
    ['Flag Reason', dispute.reconciliation_reason, 'em'],
    ['Flag Note', dispute.reconciliation_note, 'em'],
    ['Created', dispute.created_at ? new Date(dispute.created_at).toLocaleString() : null, 'span'],
    ['Updated', dispute.updated_at ? new Date(dispute.updated_at).toLocaleString() : null, 'span'],
  ];
  for (const [label, value, tag] of rows) {
    if (value !== undefined && value !== null && value !== '') detailsEl.appendChild(detailRow(label, value, tag));
  }

  document.getElementById('resolve-dispute-reason').value = '';
  hide(document.getElementById('resolve-dispute-error'));
  const defaultRadio = document.querySelector('input[name="dispute-decision"][value="release_to_employee"]');
  if (defaultRadio) defaultRadio.checked = true;

  openDialog('resolve-dispute-dialog');
}

export async function submitResolveDispute() {
  if (!state.targetDispute) return;
  const decision = document.querySelector('input[name="dispute-decision"]:checked').value;
  const reason = document.getElementById('resolve-dispute-reason').value.trim();

  if (!reason) {
    const err = document.getElementById('resolve-dispute-error');
    err.textContent = 'A reason is required to resolve this dispute.';
    show(err);
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
      err.textContent = msg;
      show(err);
      return;
    }

    closeDialog('resolve-dispute-dialog');
    loadReconciliation();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('resolve-dispute-error');
    if (err) {
      err.textContent = `Dispute resolution failed: ${e.message || 'Network error'}`;
      show(err);
    } else {
      alert(`Dispute resolution failed: ${e.message || 'Network error'}`);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-reconciliation-btn');
  if (refresh) refresh.addEventListener('click', loadReconciliation);

  const prev = document.getElementById('reconciliation-prev-btn');
  if (prev) prev.addEventListener('click', () => {
    if (state.reconciliationState.page > 1) {
      state.reconciliationState.page -= 1;
      loadReconciliation();
    }
  });
  const next = document.getElementById('reconciliation-next-btn');
  if (next) next.addEventListener('click', () => {
    const st = state.reconciliationState;
    const totalPages = Math.max(1, Math.ceil(st.total / st.limit));
    if (st.page < totalPages) {
      st.page += 1;
      loadReconciliation();
    }
  });

  const cancelBtn = document.getElementById('resolve-dispute-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog('resolve-dispute-dialog'));
  const submitBtn = document.getElementById('resolve-dispute-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitResolveDispute);
}
