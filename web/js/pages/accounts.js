// Accounts directory & suspensions (ADR-0022): search, role/status filters,
// suspend / reactivate with mandatory reason, KYC docs viewer entry point.

import { api, isUnauthorized } from '../core/api.js';
import { show, hide, el, detailRow } from '../core/dom.js';
import { capitalize } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openUserDocsDialog } from './kycdocs.js';

addTranslations('accounts', {
  ar: {
    col: {
      user: 'المستخدم',
      role: 'الدور',
      verification: 'التوثيق',
      standing: 'الحالة',
      created: 'تاريخ الإنشاء',
      action: 'إجراء',
    },
    drawer: {
      title: 'تفاصيل الحساب',
      close: 'إغلاق',
      username: 'اسم المستخدم',
      email: 'البريد الإلكتروني',
      role: 'الدور',
      id: 'معرف المستخدم',
      kyc: 'حالة التوثيق',
      standing: 'حالة الحساب',
      suspensionReason: 'سبب الإيقاف',
      created: 'تاريخ الإنشاء',
      kycDocs: 'مستندات التوثيق',
      suspend: 'إيقاف الحساب',
      reactivate: 'إعادة التفعيل',
      active: 'نشط',
      suspended: 'موقوف',
      none: 'لا يوجد',
    },
  },
  en: {
    col: {
      user: 'User',
      role: 'Role',
      verification: 'Verification',
      standing: 'Standing',
      created: 'Created',
      action: 'Action',
    },
    drawer: {
      title: 'Account details',
      close: 'Close',
      username: 'Username',
      email: 'Email',
      role: 'Role',
      id: 'User ID',
      kyc: 'Verification status',
      standing: 'Account status',
      suspensionReason: 'Suspension reason',
      created: 'Created',
      kycDocs: 'KYC documents',
      suspend: 'Suspend account',
      reactivate: 'Reactivate account',
      active: 'Active',
      suspended: 'Suspended',
      none: 'None',
    },
  },
});

export async function loadAccounts() {
  hide(document.getElementById('accounts-error'));

  const st = state.accountsState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });
  if (st.search) params.set('search', st.search);
  if (st.role) params.set('role', st.role);
  if (st.status) params.set('status', st.status);

  let data;
  try {
    const res = await api(`/api/accounts?${params.toString()}`);
    if (!res.ok) throw new Error(`accounts request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('accounts-error');
    err.textContent = `Failed to load accounts: ${e.message}`;
    show(err);
    return;
  }

  const accounts = data.accounts || [];
  st.total = data.total || 0;
  st.rows = accounts;

  const table = tableController({
    tbody: document.querySelector('#accounts-table tbody'),
    countText: document.getElementById('accounts-count'),
    pageInfo: document.getElementById('accounts-page-info'),
    prevBtn: document.getElementById('accounts-prev-btn'),
    nextBtn: document.getElementById('accounts-next-btn'),
  });

  table.renderRows({
    rows: accounts,
    colCount: 6,
    emptyText: 'No matching accounts found.',
    renderRow: accountRow,
  });

  table.updatePagination({ items: accounts.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'accounts' });
}

function accountRow(acc) {
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
  const kycDocsBtn = document.createElement('button');
  kycDocsBtn.type = 'button';
  kycDocsBtn.className = 'btn-sm secondary';
  kycDocsBtn.textContent = 'KYC Docs';
  kycDocsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openUserDocsDialog(acc);
  });
  actionTd.appendChild(kycDocsBtn);

  if (isSuspended) {
    const reactivateBtn = document.createElement('button');
    reactivateBtn.type = 'button';
    reactivateBtn.className = 'btn-sm';
    reactivateBtn.textContent = 'Reactivate…';
    reactivateBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openReactivateDialog(acc);
    });
    actionTd.appendChild(reactivateBtn);
  } else {
    const suspendBtn = document.createElement('button');
    suspendBtn.type = 'button';
    suspendBtn.className = 'btn-sm danger';
    suspendBtn.textContent = 'Suspend…';
    suspendBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openSuspendDialog(acc);
    });
    actionTd.appendChild(suspendBtn);
  }
  tr.appendChild(actionTd);

  // The whole row opens the account drawer.
  tr.classList.add('account-row');
  tr.addEventListener('click', () => openAccountDrawer(acc));

  return tr;
}

// openAccountDrawer shows the account detail drawer (overlay) with the
// account's fields and the actions available for its current standing.
export function openAccountDrawer(acc) {
  if (!acc) return;
  state.targetAccount = acc;

  const details = document.getElementById('account-drawer-details');
  if (details) {
    details.textContent = '';
    details.appendChild(detailRow(t('accounts.drawer.username'), acc.username || t('accounts.drawer.none')));
    details.appendChild(detailRow(t('accounts.drawer.email'), acc.email || t('accounts.drawer.none')));
    details.appendChild(detailRow(t('accounts.drawer.role'), capitalize(acc.role)));
    details.appendChild(detailRow(t('accounts.drawer.id'), acc.id || '', 'code'));
    const vStatus = acc.kyc_status || acc.kye_status || t('accounts.drawer.none');
    details.appendChild(detailRow(t('accounts.drawer.kyc'), vStatus));
    const suspended = acc.account_status === 'suspended' || !acc.is_active;
    details.appendChild(detailRow(t('accounts.drawer.standing'), suspended ? t('accounts.drawer.suspended') : t('accounts.drawer.active')));
    if (suspended && acc.suspension_reason) {
      details.appendChild(detailRow(t('accounts.drawer.suspensionReason'), acc.suspension_reason));
    }
    details.appendChild(detailRow(t('accounts.drawer.created'), acc.created_at ? new Date(acc.created_at).toLocaleDateString() : '—'));
  }

  const actions = document.getElementById('account-drawer-actions');
  if (actions) {
    actions.textContent = '';

    const docsBtn = el('button', 'btn-sm secondary', t('accounts.drawer.kycDocs'));
    docsBtn.type = 'button';
    docsBtn.addEventListener('click', () => openUserDocsDialog(acc));
    actions.appendChild(docsBtn);

    const suspended = acc.account_status === 'suspended' || !acc.is_active;
    const actionBtn = el('button', suspended ? 'btn-sm' : 'btn-sm danger', suspended ? t('accounts.drawer.reactivate') : t('accounts.drawer.suspend'));
    actionBtn.type = 'button';
    actionBtn.addEventListener('click', () => {
      if (suspended) openReactivateDialog(acc);
      else openSuspendDialog(acc);
    });
    actions.appendChild(actionBtn);
  }

  const err = document.getElementById('account-drawer-error');
  if (err) {
    err.textContent = '';
    err.hidden = true;
  }

  show(document.getElementById('account-drawer'));
  show(document.getElementById('account-drawer-backdrop'));
}

// closeAccountDrawer hides the drawer and its backdrop.
export function closeAccountDrawer() {
  hide(document.getElementById('account-drawer'));
  hide(document.getElementById('account-drawer-backdrop'));
}

export function openSuspendDialog(acc) {
  state.targetAccount = acc;
  document.getElementById('suspend-target').textContent =
    `${acc.username} (${acc.email}) — ${capitalize(acc.role)} [ID: ${acc.id}]`;
  document.getElementById('suspend-reason').value = '';
  hide(document.getElementById('suspend-error'));
  openDialog('suspend-dialog');
}

export async function submitSuspend() {
  if (!state.targetAccount) return;
  const reason = document.getElementById('suspend-reason').value.trim();
  if (!reason) {
    const err = document.getElementById('suspend-error');
    err.textContent = 'A reason is required to suspend an account.';
    show(err);
    return;
  }

  try {
    const res = await api('/api/accounts/suspend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: state.targetAccount.id,
        reason,
      }),
    });

    if (!res.ok) {
      let msg = `Suspension failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('suspend-error');
      err.textContent = msg;
      show(err);
      return;
    }

    closeDialog('suspend-dialog');
    closeAccountDrawer();
    loadAccounts();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('suspend-error');
    if (err) {
      err.textContent = `Suspension failed: ${e.message || 'Network error'}`;
      show(err);
    } else {
      alert(`Suspension failed: ${e.message || 'Network error'}`);
    }
  }
}

export function openReactivateDialog(acc) {
  state.targetAccount = acc;
  document.getElementById('reactivate-target').textContent =
    `${acc.username} (${acc.email}) — ${capitalize(acc.role)} [ID: ${acc.id}]`;
  document.getElementById('reactivate-reason').value = '';
  hide(document.getElementById('reactivate-error'));
  openDialog('reactivate-dialog');
}

export async function submitReactivate() {
  if (!state.targetAccount) return;
  const reason = document.getElementById('reactivate-reason').value.trim();

  try {
    const res = await api('/api/accounts/reactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: state.targetAccount.id,
        reason,
      }),
    });

    if (!res.ok) {
      let msg = `Reactivation failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('reactivate-error');
      err.textContent = msg;
      show(err);
      return;
    }

    closeDialog('reactivate-dialog');
    closeAccountDrawer();
    loadAccounts();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('reactivate-error');
    if (err) {
      err.textContent = `Reactivation failed: ${e.message || 'Network error'}`;
      show(err);
    } else {
      alert(`Reactivation failed: ${e.message || 'Network error'}`);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-accounts-btn');
  if (refresh) refresh.addEventListener('click', loadAccounts);

  const form = document.getElementById('accounts-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFilters();
    });
  }
  const reset = document.getElementById('accounts-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('accounts-search-input').value = '';
    document.getElementById('accounts-role-filter').value = '';
    document.getElementById('accounts-status-filter').value = '';
    applyFilters();
  });

  const prev = document.getElementById('accounts-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.accountsState, -1, loadAccounts));
  const next = document.getElementById('accounts-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.accountsState, +1, loadAccounts));

  const drawerClose = document.getElementById('account-drawer-close');
  if (drawerClose) drawerClose.addEventListener('click', closeAccountDrawer);
  const drawerBackdrop = document.getElementById('account-drawer-backdrop');
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeAccountDrawer);

  const suspendCancel = document.getElementById('suspend-cancel');
  if (suspendCancel) suspendCancel.addEventListener('click', () => closeDialog('suspend-dialog'));
  const suspendSubmit = document.getElementById('suspend-submit');
  if (suspendSubmit) suspendSubmit.addEventListener('click', submitSuspend);

  const reactivateCancel = document.getElementById('reactivate-cancel');
  if (reactivateCancel) reactivateCancel.addEventListener('click', () => closeDialog('reactivate-dialog'));
  const reactivateSubmit = document.getElementById('reactivate-submit');
  if (reactivateSubmit) reactivateSubmit.addEventListener('click', submitReactivate);
}

function applyFilters() {
  const st = state.accountsState;
  st.search = document.getElementById('accounts-search-input').value.trim();
  st.role = document.getElementById('accounts-role-filter').value;
  st.status = document.getElementById('accounts-status-filter').value;
  st.page = 1;
  loadAccounts();
}
