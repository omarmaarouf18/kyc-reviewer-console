'use strict';

// Reviewer token is held per-tab (sessionStorage) and sent as X-Reviewer-Token
// on every console API call. The console injects the internal service token
// server-side; it is never visible here (ADR-0021 / ADR-0022).
const tokenKey = 'reviewer_token';

let activeTab = 'queue';
let dialogUser = null;
let targetAccount = null;

const accountsState = {
  page: 1,
  limit: 15,
  search: '',
  role: '',
  status: '',
  total: 0,
};

let targetDispute = null;

const reconciliationState = {
  page: 1,
  limit: 15,
  total: 0,
};

function authHeaders() {
  return { 'X-Reviewer-Token': sessionStorage.getItem(tokenKey) || '' };
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...options.headers, ...authHeaders() },
  });
  if (res.status === 401) {
    logout('Session expired or invalid token.');
    throw new Error('unauthorized');
  }
  return res;
}

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

function logout(message) {
  sessionStorage.removeItem(tokenKey);
  hide(document.getElementById('app-view'));
  show(document.getElementById('login-view'));
  if (message) {
    const err = document.getElementById('login-error');
    err.textContent = message;
    show(err);
  }
}

// ---------------------------------------------------------------------------
// Tabs Navigation
// ---------------------------------------------------------------------------

function switchTab(tab) {
  activeTab = tab;
  const queueBtn = document.getElementById('tab-queue-btn');
  const accountsBtn = document.getElementById('tab-accounts-btn');
  const reconBtn = document.getElementById('tab-reconciliation-btn');
  const queueSection = document.getElementById('queue-section');
  const accountsSection = document.getElementById('accounts-section');
  const reconSection = document.getElementById('reconciliation-section');

  queueBtn.classList.remove('active');
  accountsBtn.classList.remove('active');
  reconBtn.classList.remove('active');
  hide(queueSection);
  hide(accountsSection);
  hide(reconSection);

  if (tab === 'queue') {
    queueBtn.classList.add('active');
    show(queueSection);
    loadQueue();
  } else if (tab === 'accounts') {
    accountsBtn.classList.add('active');
    show(accountsSection);
    loadAccounts();
  } else if (tab === 'reconciliation') {
    reconBtn.classList.add('active');
    show(reconSection);
    loadReconciliation();
  }
}

// ---------------------------------------------------------------------------
// Queue Management (ADR-0021)
// ---------------------------------------------------------------------------

async function loadQueue() {
  hide(document.getElementById('queue-error'));
  let submissions;
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(`queue request failed (${res.status})`);
    submissions = await res.json();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const err = document.getElementById('queue-error');
    err.textContent = `Failed to load queue: ${e.message}`;
    show(err);
    return;
  }

  const tbody = document.querySelector('#queue-table tbody');
  tbody.textContent = '';
  const countBadge = document.getElementById('queue-badge');
  if (countBadge) countBadge.textContent = `${submissions.length}`;

  if (submissions.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = 'No submissions pending review.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const s of submissions) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    who.innerHTML = `<strong></strong><br><span class="muted"></span><br><code class="id-tag"></code>`;
    who.querySelector('strong').textContent = s.username || '(no username)';
    who.querySelector('.muted').textContent = s.email || '';
    who.querySelector('.id-tag').textContent = s.user_id || '';
    tr.appendChild(who);

    const role = document.createElement('td');
    role.textContent = s.role === 'owner' ? 'Owner (KYB)' : 'Employee (KYE)';
    tr.appendChild(role);

    const status = document.createElement('td');
    status.innerHTML = `<span class="badge badge-pending">Pending Approval</span>`;
    tr.appendChild(status);

    const docs = document.createElement('td');
    const slots = [
      ['ID Front', s.id_front_url],
      ['ID Back', s.id_back_url],
      ['Selfie', s.selfie_url],
      ['Business Proof', s.business_proof_url],
    ].filter(([, url]) => url);
    if (!slots.length && s.document_errors?.length) {
      docs.innerHTML = '<span class="error"></span>';
      docs.querySelector('.error').textContent = s.document_errors.join(', ');
    } else {
      for (const [label] of slots) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link';
        b.textContent = label;
        b.addEventListener('click', () => openDocument(slots.find(([l]) => l === label)[1]));
        docs.appendChild(b);
        docs.appendChild(document.createTextNode(' '));
      }
    }
    tr.appendChild(docs);

    const action = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Review…';
    btn.addEventListener('click', () => openReviewDialog(s));
    action.appendChild(btn);
    tr.appendChild(action);

    tbody.appendChild(tr);
  }
}

async function openDocument(signedUrl) {
  const viewToken = new URL(signedUrl, location.href).searchParams.get('token');
  const res = await api(`/api/documents/view?token=${encodeURIComponent(viewToken)}`);
  if (!res.ok) {
    alert(`Document could not be loaded (HTTP ${res.status})`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function openReviewDialog(submission) {
  dialogUser = submission;
  document.getElementById('review-target').textContent =
    `${submission.username} (${submission.email}) — ${submission.role}`;
  document.getElementById('reason').value = '';
  hide(document.getElementById('review-error'));
  const rejectRadio = document.querySelector('input[name="action"][value="reject"]');
  rejectRadio.checked = true;
  syncReasonRequirement();
  document.getElementById('review-dialog').showModal();
}

function syncReasonRequirement() {
  const reject = document.querySelector('input[name="action"][value="reject"]').checked;
  const reason = document.getElementById('reason');
  reason.required = reject;
  reason.disabled = !reject;
}

async function submitReview() {
  const action = document.querySelector('input[name="action"]:checked').value;
  const reason = document.getElementById('reason').value.trim();

  if (action === 'reject' && !reason) {
    const err = document.getElementById('review-error');
    err.textContent = 'A rejection requires a reason.';
    show(err);
    return;
  }

  const res = await api('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: dialogUser.user_id,
      action,
      reason,
    }),
  });

  if (!res.ok) {
    let msg = `Review failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* keep generic */ }
    const err = document.getElementById('review-error');
    err.textContent = msg;
    show(err);
    return;
  }

  document.getElementById('review-dialog').close();
  loadQueue();
}

// ---------------------------------------------------------------------------
// Accounts Directory & Suspension / Reactivation (ADR-0022)
// ---------------------------------------------------------------------------

async function loadAccounts() {
  hide(document.getElementById('accounts-error'));

  const params = new URLSearchParams({
    page: String(accountsState.page),
    limit: String(accountsState.limit),
  });
  if (accountsState.search) params.set('search', accountsState.search);
  if (accountsState.role) params.set('role', accountsState.role);
  if (accountsState.status) params.set('status', accountsState.status);

  let data;
  try {
    const res = await api(`/api/accounts?${params.toString()}`);
    if (!res.ok) throw new Error(`accounts request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const err = document.getElementById('accounts-error');
    err.textContent = `Failed to load accounts: ${e.message}`;
    show(err);
    return;
  }

  const accounts = data.accounts || [];
  accountsState.total = data.total || 0;

  const tbody = document.querySelector('#accounts-table tbody');
  tbody.textContent = '';

  if (accounts.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty-state';
    td.textContent = 'No matching accounts found.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const acc of accounts) {
      const tr = document.createElement('tr');

      // User Info
      const userTd = document.createElement('td');
      userTd.innerHTML = `<strong></strong><br><span class="muted"></span><br><code class="id-tag"></code>`;
      userTd.querySelector('strong').textContent = acc.username || '(no username)';
      userTd.querySelector('.muted').textContent = acc.email || '';
      userTd.querySelector('.id-tag').textContent = acc.id || '';
      tr.appendChild(userTd);

      // Role
      const roleTd = document.createElement('td');
      roleTd.textContent = capitalize(acc.role);
      tr.appendChild(roleTd);

      // Verification
      const kycTd = document.createElement('td');
      const vStatus = acc.kyc_status || acc.kye_status;
      if (vStatus === 'approved') {
        kycTd.innerHTML = `<span class="badge badge-approved">Approved</span>`;
      } else if (vStatus === 'pending_super_admin_approval') {
        kycTd.innerHTML = `<span class="badge badge-pending">Pending</span>`;
      } else if (vStatus === 'rejected') {
        kycTd.innerHTML = `<span class="badge badge-rejected">Rejected</span>`;
      } else {
        kycTd.innerHTML = `<span class="muted">None</span>`;
      }
      tr.appendChild(kycTd);

      // Standing / Account Status
      const standingTd = document.createElement('td');
      const isSuspended = acc.account_status === 'suspended' || !acc.is_active;
      if (isSuspended) {
        standingTd.innerHTML = `<span class="badge badge-suspended">Suspended</span>`;
        if (acc.suspension_reason) {
          const reasonSpan = document.createElement('div');
          reasonSpan.className = 'reason-note';
          reasonSpan.textContent = `Reason: ${acc.suspension_reason}`;
          standingTd.appendChild(reasonSpan);
        }
      } else {
        standingTd.innerHTML = `<span class="badge badge-active">Active</span>`;
      }
      tr.appendChild(standingTd);

      // Created Date
      const dateTd = document.createElement('td');
      dateTd.className = 'muted small';
      dateTd.textContent = acc.created_at ? new Date(acc.created_at).toLocaleDateString() : '—';
      tr.appendChild(dateTd);

      // Actions
      const actionTd = document.createElement('td');
      if (isSuspended) {
        const reactivateBtn = document.createElement('button');
        reactivateBtn.type = 'button';
        reactivateBtn.className = 'btn-sm';
        reactivateBtn.textContent = 'Reactivate…';
        reactivateBtn.addEventListener('click', () => openReactivateDialog(acc));
        actionTd.appendChild(reactivateBtn);
      } else {
        const suspendBtn = document.createElement('button');
        suspendBtn.type = 'button';
        suspendBtn.className = 'btn-sm danger';
        suspendBtn.textContent = 'Suspend…';
        suspendBtn.addEventListener('click', () => openSuspendDialog(acc));
        actionTd.appendChild(suspendBtn);
      }
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    }
  }

  // Update Pagination Controls
  const totalPages = Math.max(1, Math.ceil(accountsState.total / accountsState.limit));
  document.getElementById('accounts-page-info').textContent = `Page ${accountsState.page} of ${totalPages}`;
  document.getElementById('accounts-count').textContent = `Showing ${accounts.length} of ${accountsState.total} accounts`;

  const prevBtn = document.getElementById('accounts-prev-btn');
  const nextBtn = document.getElementById('accounts-next-btn');
  prevBtn.disabled = accountsState.page <= 1;
  nextBtn.disabled = accountsState.page >= totalPages;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Suspend Dialog
// ---------------------------------------------------------------------------

function openSuspendDialog(acc) {
  targetAccount = acc;
  document.getElementById('suspend-target').textContent =
    `${acc.username} (${acc.email}) — ${capitalize(acc.role)} [ID: ${acc.id}]`;
  const reasonEl = document.getElementById('suspend-reason');
  reasonEl.value = '';
  hide(document.getElementById('suspend-error'));
  document.getElementById('suspend-dialog').showModal();
}

async function submitSuspend() {
  if (!targetAccount) return;
  const reason = document.getElementById('suspend-reason').value.trim();
  if (!reason) {
    const err = document.getElementById('suspend-error');
    err.textContent = 'A reason is required to suspend an account.';
    show(err);
    return;
  }

  const res = await api('/api/accounts/suspend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: targetAccount.id,
      reason,
    }),
  });

  if (!res.ok) {
    let msg = `Suspension failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* keep generic */ }
    const err = document.getElementById('suspend-error');
    err.textContent = msg;
    show(err);
    return;
  }

  document.getElementById('suspend-dialog').close();
  loadAccounts();
}

// ---------------------------------------------------------------------------
// Reactivate Dialog
// ---------------------------------------------------------------------------

function openReactivateDialog(acc) {
  targetAccount = acc;
  document.getElementById('reactivate-target').textContent =
    `${acc.username} (${acc.email}) — ${capitalize(acc.role)} [ID: ${acc.id}]`;
  const reasonEl = document.getElementById('reactivate-reason');
  reasonEl.value = '';
  hide(document.getElementById('reactivate-error'));
  document.getElementById('reactivate-dialog').showModal();
}

async function submitReactivate() {
  if (!targetAccount) return;
  const reason = document.getElementById('reactivate-reason').value.trim();

  const res = await api('/api/accounts/reactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: targetAccount.id,
      reason,
    }),
  });

  if (!res.ok) {
    let msg = `Reactivation failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* keep generic */ }
    const err = document.getElementById('reactivate-error');
    err.textContent = msg;
    show(err);
    return;
  }

  document.getElementById('reactivate-dialog').close();
  loadAccounts();
}

// ---------------------------------------------------------------------------
// Disputes & Escrow Reconciliation (ADR-0023)
// ---------------------------------------------------------------------------

async function loadReconciliation() {
  hide(document.getElementById('reconciliation-error'));

  const params = new URLSearchParams({
    page: String(reconciliationState.page),
    limit: String(reconciliationState.limit),
  });

  let data;
  try {
    const res = await api(`/api/reconciliation/queue?${params.toString()}`);
    if (!res.ok) throw new Error(`reconciliation request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const err = document.getElementById('reconciliation-error');
    err.textContent = `Failed to load reconciliation queue: ${e.message}`;
    show(err);
    return;
  }

  const disputes = data.disputes || [];
  reconciliationState.total = data.total || 0;

  const countBadge = document.getElementById('reconciliation-badge');
  if (countBadge) countBadge.textContent = `${data.total || disputes.length}`;

  const tbody = document.querySelector('#reconciliation-table tbody');
  tbody.textContent = '';

  if (disputes.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-state';
    td.textContent = 'No jobs pending escrow reconciliation.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const d of disputes) {
      const tr = document.createElement('tr');

      // Job & Route
      const jobTd = document.createElement('td');
      jobTd.innerHTML = `<strong></strong><br><span class="muted small route-text"></span><br><code class="id-tag"></code>`;
      jobTd.querySelector('strong').textContent = `Job #${d.id.slice(-8)}`;
      jobTd.querySelector('.route-text').textContent = `${d.pickup_address || 'Pickup'} &rarr; ${d.dropoff_address || 'Dropoff'}`;
      jobTd.querySelector('.id-tag').textContent = d.id;
      tr.appendChild(jobTd);

      // Category
      const catTd = document.createElement('td');
      catTd.textContent = capitalize(d.category || 'delivery');
      tr.appendChild(catTd);

      // Distance Discrepancy
      const distTd = document.createElement('td');
      const ratio = d.booked_distance > 0 ? (d.actual_distance / d.booked_distance) * 100 : 0;
      distTd.innerHTML = `<span class="dist-stat"><strong>${d.actual_distance.toFixed(1)} km</strong> tracked</span><br>` +
        `<span class="muted small">Booked: ${d.booked_distance.toFixed(1)} km (${ratio.toFixed(0)}%)</span><br>` +
        `<span class="muted small">${d.waypoints_count || 0} waypoints</span>`;
      if (ratio < 70) {
        distTd.querySelector('.dist-stat').classList.add('warning-text');
      }
      tr.appendChild(distTd);

      // Locked Escrow
      const escrowTd = document.createElement('td');
      escrowTd.innerHTML = `<strong>${d.locked_escrow_amount.toFixed(2)} EGP</strong>`;
      tr.appendChild(escrowTd);

      // Payment
      const payTd = document.createElement('td');
      payTd.innerHTML = `<span class="badge ${d.payment_method === 'cod' ? 'badge-cod' : 'badge-wallet'}">${d.payment_method ? d.payment_method.toUpperCase() : 'WALLET'}</span>`;
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

      tbody.appendChild(tr);
    }
  }

  // Update Pagination Controls
  const totalPages = Math.max(1, Math.ceil(reconciliationState.total / reconciliationState.limit));
  document.getElementById('reconciliation-page-info').textContent = `Page ${reconciliationState.page} of ${totalPages}`;
  document.getElementById('reconciliation-count').textContent = `Showing ${disputes.length} of ${reconciliationState.total} disputed jobs`;

  const prevBtn = document.getElementById('reconciliation-prev-btn');
  const nextBtn = document.getElementById('reconciliation-next-btn');
  prevBtn.disabled = reconciliationState.page <= 1;
  nextBtn.disabled = reconciliationState.page >= totalPages;
}

// ---------------------------------------------------------------------------
// Resolve Dispute Dialog (ADR-0023)
// ---------------------------------------------------------------------------

function openResolveDisputeDialog(dispute) {
  targetDispute = dispute;
  document.getElementById('resolve-dispute-target').textContent =
    `Dispute on Job ${dispute.id}`;

  const detailsEl = document.getElementById('resolve-dispute-details');
  const ratio = dispute.booked_distance > 0 ? ((dispute.actual_distance / dispute.booked_distance) * 100).toFixed(0) : '0';
  detailsEl.innerHTML = `
    <div class="detail-row"><span>Category:</span> <strong>${capitalize(dispute.category || 'delivery')}</strong></div>
    <div class="detail-row"><span>Route:</span> <strong>${dispute.pickup_address} &rarr; ${dispute.dropoff_address}</strong></div>
    <div class="detail-row"><span>Booked vs Tracked:</span> <strong>${dispute.booked_distance.toFixed(1)} km vs ${dispute.actual_distance.toFixed(1)} km (${ratio}%)</strong></div>
    <div class="detail-row"><span>Locked Escrow:</span> <strong>${dispute.locked_escrow_amount.toFixed(2)} EGP</strong></div>
    <div class="detail-row"><span>Tenant Owner:</span> <code>${dispute.owner_id}</code></div>
    <div class="detail-row"><span>Assigned Courier:</span> <code>${dispute.employee_id || '(none)'}</code></div>
    <div class="detail-row"><span>Customer:</span> <code>${dispute.customer_id}</code></div>
    <div class="detail-row"><span>Flag Note:</span> <em>${dispute.reconciliation_reason || dispute.reconciliation_note || 'under_distance_mismatch'}</em></div>
  `;

  document.getElementById('resolve-dispute-reason').value = '';
  hide(document.getElementById('resolve-dispute-error'));
  const defaultRadio = document.querySelector('input[name="dispute-decision"][value="release_to_employee"]');
  if (defaultRadio) defaultRadio.checked = true;

  document.getElementById('resolve-dispute-dialog').showModal();
}

async function submitResolveDispute() {
  if (!targetDispute) return;
  const decision = document.querySelector('input[name="dispute-decision"]:checked').value;
  const reason = document.getElementById('resolve-dispute-reason').value.trim();

  if (!reason) {
    const err = document.getElementById('resolve-dispute-error');
    err.textContent = 'A reason is required to resolve this dispute.';
    show(err);
    return;
  }

  const res = await api('/api/reconciliation/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: targetDispute.id,
      decision,
      reason,
    }),
  });

  if (!res.ok) {
    let msg = `Dispute resolution failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* keep generic */ }
    const err = document.getElementById('resolve-dispute-error');
    err.textContent = msg;
    show(err);
    return;
  }

  document.getElementById('resolve-dispute-dialog').close();
  loadReconciliation();
}

// ---------------------------------------------------------------------------
// Event Listeners Initialization
// ---------------------------------------------------------------------------

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tok = document.getElementById('token').value.trim();
  if (!tok) return;

  sessionStorage.setItem(tokenKey, tok);
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(res.status === 401 ? null : `HTTP ${res.status}`);
    hide(document.getElementById('login-view'));
    hide(document.getElementById('login-error'));
    show(document.getElementById('app-view'));
    switchTab('queue');
  } catch (err) {
    sessionStorage.removeItem(tokenKey);
    const el = document.getElementById('login-error');
    el.textContent = err.message === 'unauthorized'
      ? 'Invalid reviewer token.' : `Sign-in failed: ${err.message}`;
    show(el);
  }
});

document.getElementById('logout-btn').addEventListener('click', () => logout());
document.getElementById('tab-queue-btn').addEventListener('click', () => switchTab('queue'));
document.getElementById('tab-accounts-btn').addEventListener('click', () => switchTab('accounts'));
document.getElementById('tab-reconciliation-btn').addEventListener('click', () => switchTab('reconciliation'));

document.getElementById('refresh-queue-btn').addEventListener('click', loadQueue);
document.getElementById('refresh-accounts-btn').addEventListener('click', loadAccounts);
document.getElementById('refresh-reconciliation-btn').addEventListener('click', loadReconciliation);

document.getElementById('review-cancel').addEventListener('click', () => document.getElementById('review-dialog').close());
document.getElementById('review-submit').addEventListener('click', submitReview);
for (const radio of document.querySelectorAll('input[name="action"]')) {
  radio.addEventListener('change', syncReasonRequirement);
}

document.getElementById('suspend-cancel').addEventListener('click', () => document.getElementById('suspend-dialog').close());
document.getElementById('suspend-submit').addEventListener('click', submitSuspend);

document.getElementById('reactivate-cancel').addEventListener('click', () => document.getElementById('reactivate-dialog').close());
document.getElementById('reactivate-submit').addEventListener('click', submitReactivate);

document.getElementById('resolve-dispute-cancel').addEventListener('click', () => document.getElementById('resolve-dispute-dialog').close());
document.getElementById('resolve-dispute-submit').addEventListener('click', submitResolveDispute);

// Accounts Toolbar and Search
document.getElementById('accounts-filter-form').addEventListener('submit', (e) => {
  e.preventDefault();
  accountsState.search = document.getElementById('accounts-search-input').value.trim();
  accountsState.role = document.getElementById('accounts-role-filter').value;
  accountsState.status = document.getElementById('accounts-status-filter').value;
  accountsState.page = 1;
  loadAccounts();
});

document.getElementById('accounts-reset-btn').addEventListener('click', () => {
  document.getElementById('accounts-search-input').value = '';
  document.getElementById('accounts-role-filter').value = '';
  document.getElementById('accounts-status-filter').value = '';
  accountsState.search = '';
  accountsState.role = '';
  accountsState.status = '';
  accountsState.page = 1;
  loadAccounts();
});

document.getElementById('accounts-prev-btn').addEventListener('click', () => {
  if (accountsState.page > 1) {
    accountsState.page--;
    loadAccounts();
  }
});

document.getElementById('accounts-next-btn').addEventListener('click', () => {
  const totalPages = Math.ceil(accountsState.total / accountsState.limit);
  if (accountsState.page < totalPages) {
    accountsState.page++;
    loadAccounts();
  }
});

// Reconciliation Pagination
document.getElementById('reconciliation-prev-btn').addEventListener('click', () => {
  if (reconciliationState.page > 1) {
    reconciliationState.page--;
    loadReconciliation();
  }
});

document.getElementById('reconciliation-next-btn').addEventListener('click', () => {
  const totalPages = Math.ceil(reconciliationState.total / reconciliationState.limit);
  if (reconciliationState.page < totalPages) {
    reconciliationState.page++;
    loadReconciliation();
  }
});

