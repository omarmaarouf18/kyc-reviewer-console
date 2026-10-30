// Jobs lookup & support mutations (ADMIN_API § 3): search jobs across
// tenants, open the full job model (it carries unmasked phones, and every
// view is audited upstream as job.view), cancel a job and repair a stuck COD
// job. Both mutations require a mandatory reason.
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { show, hide, el, badge } from '../core/dom.js';
import { num } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { tableController, changePage } from '../core/ui/table.js';

addTranslations('jobs', {
  ar: {
    title: 'المهام',
    refresh: 'تحديث',
    filter: 'بحث',
    reset: 'مسح',
    empty: 'لا توجد مهام مطابقة.',
    col: {
      id: 'معرف المهمة',
      status: 'الحالة',
      customer: 'العميل',
      recipient: 'المستلم',
      price: 'السعر',
      payment: 'الدفع',
      created: 'أُنشئت',
      action: 'إجراء',
    },
    status: {
      pending: 'بانتظار المندوب',
      pending_dispatch: 'بندور على مندوب',
      unavailable: 'مفيش مندوب متاح',
      awaiting_price_response: 'فيه عرض سعر',
      active: 'في الطريق',
      completed: 'اتسلم',
      cancelled: 'اتلغى',
      escrow_reconciliation_required: 'بيتراجع',
      unknown: 'حالة مش معروفة',
    },
    payment: {
      cod: 'نقدًا عند الاستلام',
      wallet: 'محفظة',
      unknown: 'غير معروف',
    },
    detail: {
      title: 'تفاصيل المهمة',
      close: 'إغلاق',
      cancelJob: 'إلغاء المهمة',
      completeCod: 'إتمام COD عالق',
      history: 'سجل الحالة',
      customer: 'العميل',
      customerPhone: 'هاتف العميل',
      courier: 'المندوب',
      courierPhone: 'هاتف المندوب',
      pickup: 'عنوان الاستلام',
      dropoff: 'عنوان التسليم',
      recipient: 'المستلم',
      package: 'الطرد',
      price: 'السعر',
      payment: 'الدفع',
      escrow: 'الضمان المحجوز',
      reconciliation: 'أعلام المطابقة',
      created: 'أُنشئت',
      updated: 'آخر تحديث',
      noHistory: 'لا يوجد سجل.',
      noNotifications: 'لا توجد إشعارات.',
      notifications: 'الإشعارات الأخيرة',
      viewFailed: 'فشل تحميل تفاصيل المهمة: {error}',
      loadFailed: 'فشل تحميل المهام: {error}',
    },
    cancel: {
      title: 'إلغاء المهمة',
      warning: 'Cancelling releases courier locks, refunds locked escrow for wallet-paid jobs and notifies the parties.',
      reason: 'سبب الإلغاء',
      submit: 'تأكيد الإلغاء',
      close: 'إلغاء',
      required: 'سبب الإلغاء مطلوب.',
      failed: 'فشل إلغاء المهمة: {error}',
    },
    cod: {
      title: 'إتمام مهمة COD عالقة',
      info: 'Only for jobs in escrow reconciliation with cash already collected (payment method COD, no locked escrow).',
      reason: 'سبب الإتمام',
      submit: 'تأكيد الإتمام',
      close: 'إلغاء',
      required: 'سبب الإتمام مطلوب.',
      failed: 'فشل إتمام المهمة: {error}',
    },
  },
  en: {
    title: 'Jobs',
    refresh: 'Refresh',
    filter: 'Filter',
    reset: 'Reset',
    empty: 'No matching jobs found.',
    col: {
      id: 'Job ID',
      status: 'Status',
      customer: 'Customer',
      recipient: 'Recipient',
      price: 'Price',
      payment: 'Payment',
      created: 'Created',
      action: 'Action',
    },
    status: {
      pending: 'Waiting for courier',
      pending_dispatch: 'Finding a courier',
      unavailable: 'No courier available',
      awaiting_price_response: 'New price offered',
      active: 'On the way',
      completed: 'Delivered',
      cancelled: 'Cancelled',
      escrow_reconciliation_required: 'Under review',
      unknown: 'Unknown status',
    },
    payment: {
      cod: 'Cash on delivery',
      wallet: 'Wallet',
      unknown: 'Unknown',
    },
    detail: {
      title: 'Job details',
      close: 'Close',
      cancelJob: 'Cancel job',
      completeCod: 'Complete stuck COD',
      history: 'Status history',
      customer: 'Customer',
      customerPhone: 'Customer phone',
      courier: 'Courier',
      courierPhone: 'Courier phone',
      pickup: 'Pickup address',
      dropoff: 'Dropoff address',
      recipient: 'Recipient',
      package: 'Package',
      price: 'Price',
      payment: 'Payment',
      escrow: 'Locked escrow',
      reconciliation: 'Reconciliation flags',
      created: 'Created',
      updated: 'Updated',
      noHistory: 'No history.',
      noNotifications: 'No notifications.',
      notifications: 'Recent notifications',
      viewFailed: 'Failed to load job details: {error}',
      loadFailed: 'Failed to load jobs: {error}',
    },
    cancel: {
      title: 'Cancel job',
      warning: 'Cancelling releases courier locks, refunds locked escrow for wallet-paid jobs and notifies the parties.',
      reason: 'Cancellation reason',
      submit: 'Confirm cancellation',
      close: 'Cancel',
      required: 'A cancellation reason is required.',
      failed: 'Failed to cancel job: {error}',
    },
    cod: {
      title: 'Complete stuck COD job',
      info: 'Only for jobs in escrow reconciliation with cash already collected (payment method COD, no locked escrow).',
      reason: 'Completion reason',
      submit: 'Confirm completion',
      close: 'Cancel',
      required: 'A completion reason is required.',
      failed: 'Failed to complete job: {error}',
    },
  },
});

// Status labels and badge classes come from fixed maps, never from the API
// value itself (design system job status chips).
const STATUS_LABELS = {
  pending: 'pending',
  pending_dispatch: 'pending_dispatch',
  unavailable: 'unavailable',
  awaiting_price_response: 'awaiting_price_response',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  escrow_reconciliation_required: 'escrow_reconciliation_required',
  reconciliation_required: 'escrow_reconciliation_required',
};

function statusBadge(status) {
  const key = STATUS_LABELS[status] || 'unknown';
  const className = {
    pending: 'badge-pending',
    pending_dispatch: 'badge-pending',
    unavailable: 'badge-rejected',
    awaiting_price_response: 'badge-pending',
    active: 'badge-assigned',
    completed: 'badge-approved',
    cancelled: 'badge-cancelled',
    escrow_reconciliation_required: 'badge-pending',
    unknown: 'badge-free',
  }[key];
  return badge(className, t(`jobs.status.${key}`));
}

function paymentBadge(method) {
  if (method === 'cod') return badge('badge-cod', t('jobs.payment.cod'));
  if (method === 'wallet') return badge('badge-wallet', t('jobs.payment.wallet'));
  return badge('badge-free', t('jobs.payment.unknown'));
}

export async function loadJobs() {
  hide(document.getElementById('jobs-error'));

  const st = state.jobsState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });
  if (st.jobId) params.set('job_id', st.jobId);
  if (st.customerId) params.set('customer_id', st.customerId);
  if (st.status) params.set('status', st.status);
  if (st.from) params.set('from', st.from);
  if (st.to) params.set('to', st.to);

  let data;
  try {
    const res = await api(`/api/jobs?${params.toString()}`);
    if (!res.ok) throw new Error(`jobs request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('jobs-error');
    if (err) {
      err.textContent = t('jobs.detail.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  st.total = data.total || jobs.length;
  st.rows = jobs;

  const table = tableController({
    tbody: document.querySelector('#jobs-table tbody'),
    countText: document.getElementById('jobs-count'),
    pageInfo: document.getElementById('jobs-page-info'),
    prevBtn: document.getElementById('jobs-prev-btn'),
    nextBtn: document.getElementById('jobs-next-btn'),
  });

  table.renderRows({
    rows: jobs,
    colCount: 8,
    emptyText: t('jobs.empty'),
    renderRow: jobRow,
  });

  table.updatePagination({ items: jobs.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'jobs' });
}

function jobRow(job) {
  const tr = document.createElement('tr');

  const idTd = document.createElement('td');
  idTd.appendChild(el('code', 'id-tag', job.id || ''));
  tr.appendChild(idTd);

  const statusTd = document.createElement('td');
  statusTd.appendChild(statusBadge(job.status));
  if (job.sub_status) {
    statusTd.appendChild(document.createTextNode(' '));
    statusTd.appendChild(el('span', 'muted small', job.sub_status));
  }
  tr.appendChild(statusTd);

  const customerTd = document.createElement('td');
  customerTd.appendChild(el('strong', '', job.customer_name || '—'));
  customerTd.appendChild(document.createTextNode(' '));
  customerTd.appendChild(el('code', 'id-tag', job.user_id || job.customer_id || ''));
  tr.appendChild(customerTd);

  const recipientTd = document.createElement('td');
  const recipient = job.recipient || {};
  recipientTd.appendChild(el('span', '', recipient.name || '—'));
  if (recipient.phone) {
    recipientTd.appendChild(document.createElement('br'));
    recipientTd.appendChild(el('code', 'id-tag', recipient.phone));
  }
  tr.appendChild(recipientTd);

  const priceTd = document.createElement('td');
  const price = job.agreed_price ?? job.suggested_price;
  priceTd.appendChild(el('strong', '', price === undefined || price === null ? '—' : `${num(price).toFixed(2)} EGP`));
  tr.appendChild(priceTd);

  const paymentTd = document.createElement('td');
  paymentTd.appendChild(paymentBadge(job.payment_method));
  tr.appendChild(paymentTd);

  const createdTd = document.createElement('td');
  createdTd.className = 'muted small';
  createdTd.textContent = job.created_at ? new Date(job.created_at).toLocaleString() : '—';
  tr.appendChild(createdTd);

  const actionTd = document.createElement('td');
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn-sm secondary';
  viewBtn.textContent = t('jobs.detail.title');
  viewBtn.addEventListener('click', () => openJobDetail(job.id));
  actionTd.appendChild(viewBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-sm danger';
  cancelBtn.textContent = t('jobs.detail.cancelJob');
  cancelBtn.addEventListener('click', () => openJobCancelDialog(job));
  actionTd.appendChild(cancelBtn);

  tr.appendChild(actionTd);

  return tr;
}

// openJobDetail loads the full job model and fills the detail dialog.
export async function openJobDetail(jobId) {
  if (!jobId) return;
  state.jobsState.currentId = jobId;

  const err = document.getElementById('job-detail-error');
  if (err) {
    err.textContent = '';
    err.hidden = true;
  }

  let job;
  try {
    const res = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) throw new Error(`job detail request failed (${res.status})`);
    job = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    if (err) {
      err.textContent = t('jobs.detail.viewFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const target = document.getElementById('job-detail-target');
  if (target) target.textContent = job.id || jobId;

  const body = document.getElementById('job-detail-body');
  if (body) {
    body.textContent = '';
    body.appendChild(el('div', 'detail-row', ''));
    body.appendChild(detail('jobs.detail.customer', job.customer_name || '—'));
    body.appendChild(detail('jobs.detail.customerPhone', job.customer_phone || '—', 'code'));
    body.appendChild(detail('jobs.detail.courier', job.courier_name || job.courier || '—'));
    body.appendChild(detail('jobs.detail.courierPhone', job.courier_phone || '—', 'code'));
    body.appendChild(detail('jobs.detail.pickup', job.pickup_address || job.location?.address || '—'));
    body.appendChild(detail('jobs.detail.dropoff', job.dropoff_address || job.destination?.address || '—'));
    body.appendChild(detail('jobs.detail.recipient', job.recipient?.name || '—'));
    body.appendChild(detail('jobs.detail.package', job.package?.description || job.package_details || '—'));
    const price = job.price?.amount ?? job.price ?? job.agreed_price ?? job.suggested_price;
    body.appendChild(detail('jobs.detail.price', price === undefined || price === null ? '—' : `${num(price).toFixed(2)} EGP`));
    body.appendChild(detail('jobs.detail.payment', job.payment_method || '—'));
    body.appendChild(detail('jobs.detail.escrow', job.locked_escrow_amount === undefined ? '—' : `${num(job.locked_escrow_amount).toFixed(2)} EGP`));
    const flags = job.reconciliation || job.reconciliation_flags;
    body.appendChild(detail('jobs.detail.reconciliation', flags ? JSON.stringify(flags) : '—'));
    body.appendChild(detail('jobs.detail.created', job.created_at || '—'));
    body.appendChild(detail('jobs.detail.updated', job.updated_at || '—'));
  }

  const history = document.getElementById('job-detail-history');
  if (history) {
    history.textContent = '';
    const entries = Array.isArray(job.status_history) ? job.status_history : [];
    if (!entries.length) {
      history.appendChild(el('p', 'muted', t('jobs.detail.noHistory')));
    } else {
      for (const entry of entries) {
        const row = el('div', 'job-history-entry');
        row.appendChild(statusBadge(entry.status));
        row.appendChild(document.createTextNode(' '));
        row.appendChild(el('span', 'muted small', entry.timestamp || ''));
        history.appendChild(row);
      }
    }
  }

  openDialog('job-detail-dialog');
}

// detail builds one label/value row of the job detail card.
function detail(labelKey, value, tag = 'strong') {
  const row = el('div', 'detail-row');
  row.appendChild(el('span', '', `${t(labelKey)}:`));
  row.appendChild(document.createTextNode(' '));
  row.appendChild(el(tag, '', value));
  return row;
}

export function openJobCancelDialog(job) {
  state.jobsState.cancelTarget = job;
  const target = document.getElementById('job-cancel-target');
  if (target) target.textContent = job ? `${job.id || ''} — ${job.customer_name || job.user_id || ''}` : '';
  const reason = document.getElementById('job-cancel-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('job-cancel-error'));
  openDialog('job-cancel-dialog');
}

export async function submitJobCancel() {
  const job = state.jobsState.cancelTarget;
  if (!job) return;
  const reasonEl = document.getElementById('job-cancel-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    const err = document.getElementById('job-cancel-error');
    if (err) {
      err.textContent = t('jobs.cancel.required');
      show(err);
    }
    return;
  }

  try {
    const res = await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      let msg = `Cancellation failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('job-cancel-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    state.jobsState.cancelTarget = null;
    closeDialog('job-cancel-dialog');
    closeDialog('job-detail-dialog');
    loadJobs();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('job-cancel-error');
    if (err) {
      err.textContent = t('jobs.cancel.failed', { error: e.message || 'Network error' });
      show(err);
    }
  }
}

export function openJobCodDialog(job) {
  state.jobsState.codTarget = job;
  const target = document.getElementById('job-cod-target');
  if (target) target.textContent = job ? `${job.id || ''} — ${job.customer_name || job.user_id || ''}` : '';
  const reason = document.getElementById('job-cod-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('job-cod-error'));
  openDialog('job-cod-dialog');
}

export async function submitJobCod() {
  const job = state.jobsState.codTarget;
  if (!job) return;
  const reasonEl = document.getElementById('job-cod-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    const err = document.getElementById('job-cod-error');
    if (err) {
      err.textContent = t('jobs.cod.required');
      show(err);
    }
    return;
  }

  try {
    const res = await api(`/api/jobs/${encodeURIComponent(job.id)}/complete-stuck-cod`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      let msg = `Completion failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('job-cod-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    state.jobsState.codTarget = null;
    closeDialog('job-cod-dialog');
    closeDialog('job-detail-dialog');
    loadJobs();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('job-cod-error');
    if (err) {
      err.textContent = t('jobs.cod.failed', { error: e.message || 'Network error' });
      show(err);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-jobs-btn');
  if (refresh) refresh.addEventListener('click', loadJobs);

  const form = document.getElementById('jobs-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyJobFilters();
    });
  }
  const reset = document.getElementById('jobs-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('jobs-id-input').value = '';
    document.getElementById('jobs-customer-input').value = '';
    document.getElementById('jobs-status-filter').value = '';
    document.getElementById('jobs-from-input').value = '';
    document.getElementById('jobs-to-input').value = '';
    applyJobFilters();
  });

  const prev = document.getElementById('jobs-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.jobsState, -1, loadJobs));
  const next = document.getElementById('jobs-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.jobsState, +1, loadJobs));

  const detailClose = document.getElementById('job-detail-close');
  if (detailClose) detailClose.addEventListener('click', () => closeDialog('job-detail-dialog'));

  const detailCancel = document.getElementById('job-detail-cancel-job');
  if (detailCancel) {
    detailCancel.addEventListener('click', () => {
      const job = state.jobsState.currentId ? { id: state.jobsState.currentId } : null;
      openJobCancelDialog(job);
    });
  }
  const detailCod = document.getElementById('job-detail-complete-cod');
  if (detailCod) {
    detailCod.addEventListener('click', () => {
      const job = state.jobsState.currentId ? { id: state.jobsState.currentId } : null;
      openJobCodDialog(job);
    });
  }

  const cancelClose = document.getElementById('job-cancel-cancel');
  if (cancelClose) cancelClose.addEventListener('click', () => closeDialog('job-cancel-dialog'));
  const cancelSubmit = document.getElementById('job-cancel-submit');
  if (cancelSubmit) cancelSubmit.addEventListener('click', submitJobCancel);

  const codClose = document.getElementById('job-cod-cancel');
  if (codClose) codClose.addEventListener('click', () => closeDialog('job-cod-dialog'));
  const codSubmit = document.getElementById('job-cod-submit');
  if (codSubmit) codSubmit.addEventListener('click', submitJobCod);
}

function applyJobFilters() {
  const st = state.jobsState;
  st.jobId = document.getElementById('jobs-id-input').value.trim();
  st.customerId = document.getElementById('jobs-customer-input').value.trim();
  st.status = document.getElementById('jobs-status-filter').value;
  st.from = document.getElementById('jobs-from-input').value;
  st.to = document.getElementById('jobs-to-input').value;
  st.page = 1;
  loadJobs();
}
