// KYC / KYB / KYE review queue (ADR-0021): pending submissions, documents,
// approve / reject.
//
// The queue is a list + side panel: picking a row (click, Enter, or the
// arrow/j/k shortcuts) opens the review panel with the submission details,
// its document links and the approve/reject decision. Shortcuts: ↑/↓ (or k/j)
// move the selection, Enter opens the panel, a approves, r rejects, Esc
// closes, ? toggles the hint line.
//
// XSS rule: every API value reaches the DOM through textContent (el(),
// detailRow()); innerHTML is used only for static markup without
// interpolation.

import { api, isUnauthorized } from '../core/api.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { show, hide, el, detailRow } from '../core/dom.js';

addTranslations('kyc', {
  ar: {
    title: 'قيد المراجعة',
    refresh: 'تحديث القائمة',
    col: {
      user: 'المستخدم',
      role: 'الدور',
      status: 'الحالة',
      documents: 'المستندات',
      action: 'إجراء',
    },
    empty: 'لا توجد طلبات قيد المراجعة.',
    pending: 'بانتظار الموافقة',
    owner: 'مالك (KYB)',
    employee: 'موظف (KYE)',
    noUsername: 'بدون اسم مستخدم',
    open: 'فتح',
    panel: {
      title: 'تفاصيل المراجعة',
      close: 'إغلاق',
      approve: 'قبول',
      reject: 'رفض',
      reason: 'سبب الرفض',
      reasonPlaceholder: 'اشرح سبب رفض الطلب',
      submit: 'إرسال المراجعة',
      username: 'اسم المستخدم',
      email: 'البريد الإلكتروني',
      role: 'الدور',
      userId: 'معرف المستخدم',
      status: 'الحالة',
      documents: 'المستندات',
      noDocuments: 'لا توجد مستندات متاحة',
      reasonRequired: 'الرفض يتطلب سببًا.',
      reviewFailed: 'فشل المراجعة: {error}',
      approveFailed: 'فشل قبول الطلب (HTTP {status})',
      noSelection: 'لا يوجد طلب محدد.',
    },
    shortcuts: {
      hint: 'اختصارات: ↑/↓ أو j/k للتنقل • Enter للفتح • a للقبول • r للرفض • Esc للإغلاق • ? للمساعدة',
      move: 'تنقل',
      open: 'فتح',
      approve: 'قبول',
      reject: 'رفض',
      close: 'إغلاق',
      help: 'مساعدة',
    },
  },
  en: {
    title: 'Pending Submissions',
    refresh: 'Refresh Queue',
    col: {
      user: 'User',
      role: 'Role',
      status: 'Status',
      documents: 'Documents',
      action: 'Action',
    },
    empty: 'No submissions pending review.',
    pending: 'Pending Approval',
    owner: 'Owner (KYB)',
    employee: 'Employee (KYE)',
    noUsername: '(no username)',
    open: 'Open',
    panel: {
      title: 'Review details',
      close: 'Close',
      approve: 'Approve',
      reject: 'Reject',
      reason: 'Rejection reason',
      reasonPlaceholder: 'Explain why this submission is rejected',
      submit: 'Submit review',
      username: 'Username',
      email: 'Email',
      role: 'Role',
      userId: 'User ID',
      status: 'Status',
      documents: 'Documents',
      noDocuments: 'No documents available',
      reasonRequired: 'A rejection requires a reason.',
      reviewFailed: 'Review failed: {error}',
      approveFailed: 'Review failed (HTTP {status})',
      noSelection: 'No submission selected.',
    },
    shortcuts: {
      hint: 'Shortcuts: ↑/↓ or j/k to move • Enter to open • a to approve • r to reject • Esc to close • ? for help',
      move: 'move',
      open: 'open',
      approve: 'approve',
      reject: 'reject',
      close: 'close',
      help: 'help',
    },
  },
});

// The queue page: string table (Arabic first, English mirrored) in i18n.js.
export async function loadQueue() {
  const errEl = document.getElementById('queue-error');
  if (errEl) errEl.hidden = true;
  let submissions;
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(`queue request failed (${res.status})`);
    submissions = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('queue-error');
    if (err) {
      err.textContent = `Failed to load queue: ${e.message}`;
      err.hidden = false;
    }
    return;
  }

  const tbody = document.querySelector('#queue-table tbody');
  if (!tbody) return;
  tbody.textContent = '';
  const rows = Array.isArray(submissions) ? submissions : [];
  state.queueState.submissions = rows;
  state.queueState.selectedIndex = -1;
  const countBadge = document.getElementById('queue-badge');
  if (countBadge) countBadge.textContent = `${rows.length}`;

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = t('kyc.empty');
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((s, index) => tbody.appendChild(queueRow(s, index)));
}

function queueRow(s, index) {
  const tr = document.createElement('tr');
  tr.setAttribute('data-index', String(index));
  tr.classList.add('queue-row');

  const who = document.createElement('td');
  who.innerHTML = `<strong></strong><br><span class="muted"></span><br><code class="id-tag"></code>`;
  who.querySelector('strong').textContent = s.username || t('kyc.noUsername');
  who.querySelector('.muted').textContent = s.email || '';
  who.querySelector('.id-tag').textContent = s.user_id || '';
  tr.appendChild(who);

  const role = document.createElement('td');
  role.textContent = s.role === 'owner' ? t('kyc.owner') : t('kyc.employee');
  tr.appendChild(role);

  const status = document.createElement('td');
  status.innerHTML = `<span class="badge badge-pending"></span>`;
  status.querySelector('.badge').textContent = t('kyc.pending');
  tr.appendChild(status);

  const docs = document.createElement('td');
  const slots = documentSlots(s);
  if (!slots.length && s.document_errors?.length) {
    const err = document.createElement('span');
    err.className = 'error';
    err.textContent = s.document_errors.join(', ');
    docs.appendChild(err);
  } else {
    for (const [label, url] of slots) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openDocument(url);
      });
      docs.appendChild(b);
      docs.appendChild(document.createTextNode(' '));
    }
  }
  tr.appendChild(docs);

  const action = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('kyc.open');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectQueueRow(index, true);
  });
  action.appendChild(btn);
  tr.appendChild(action);

  tr.addEventListener('click', () => selectQueueRow(index, true));
  return tr;
}

// documentSlots lists the signed document links of a submission (if any).
function documentSlots(s) {
  return [
    ['ID Front', s.id_front_url],
    ['ID Back', s.id_back_url],
    ['Selfie', s.selfie_url],
    ['Business Proof', s.business_proof_url],
  ].filter(([, url]) => url);
}

// selectQueueRow moves the selection and optionally opens the review panel.
export function selectQueueRow(index, openPanel = false) {
  const rows = state.queueState.submissions;
  if (!rows.length) return;
  const bounded = Math.max(0, Math.min(index, rows.length - 1));
  state.queueState.selectedIndex = bounded;
  for (const tr of document.querySelectorAll('#queue-table tbody tr')) {
    tr.classList.toggle('selected', Number(tr.getAttribute('data-index')) === bounded);
  }
  if (openPanel) openReviewPanel(rows[bounded]);
}

// moveSelection moves the selection by delta (keyboard navigation).
export function moveSelection(delta) {
  const rows = state.queueState.submissions;
  if (!rows.length) return;
  const current = state.queueState.selectedIndex;
  const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : current + delta;
  selectQueueRow(Math.max(0, Math.min(next, rows.length - 1)), false);
}

// openReviewPanel fills the side panel with the selected submission.
export function openReviewPanel(submission) {
  if (!submission) return;
  state.queueState.current = submission;

  const details = document.getElementById('kyc-panel-details');
  if (details) {
    details.textContent = '';
    details.appendChild(detailRow(t('kyc.panel.username'), submission.username || ''));
    details.appendChild(detailRow(t('kyc.panel.email'), submission.email || ''));
    details.appendChild(detailRow(t('kyc.panel.role'), submission.role === 'owner' ? t('kyc.owner') : t('kyc.employee')));
    details.appendChild(detailRow(t('kyc.panel.userId'), submission.user_id || '', 'code'));
    details.appendChild(detailRow(t('kyc.panel.status'), t('kyc.pending')));
  }

  const docs = document.getElementById('kyc-panel-docs');
  const docsError = document.getElementById('kyc-panel-docs-error');
  if (docs) {
    docs.textContent = '';
    const slots = documentSlots(submission);
    if (slots.length) {
      for (const [label, url] of slots) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-sm secondary';
        b.textContent = label;
        b.addEventListener('click', () => openDocument(url));
        docs.appendChild(b);
      }
      if (docsError) docsError.hidden = true;
    } else {
      if (submission.document_errors?.length) {
        if (docsError) {
          docsError.textContent = submission.document_errors.join(', ');
          docsError.hidden = false;
        }
      } else {
        const p = el('p', 'muted', t('kyc.panel.noDocuments'));
        docs.appendChild(p);
      }
    }
  }

  const reason = document.getElementById('kyc-panel-reason');
  if (reason) reason.value = '';
  const approveRadio = document.querySelector('input[name="kyc-panel-action"][value="approve"]');
  if (approveRadio) approveRadio.checked = true;
  syncReasonRequirement();

  const err = document.getElementById('kyc-panel-error');
  if (err) {
    err.textContent = '';
    err.hidden = true;
  }

  show(document.getElementById('kyc-panel'));
}

// closeReviewPanel hides the panel and clears its target.
export function closeReviewPanel() {
  state.queueState.current = null;
  hide(document.getElementById('kyc-panel'));
}

// syncReasonRequirement makes the reason mandatory only for a rejection.
export function syncReasonRequirement() {
  const rejectRadio = document.querySelector('input[name="kyc-panel-action"][value="reject"]');
  const reason = document.getElementById('kyc-panel-reason');
  if (!rejectRadio || !reason) return;
  const reject = rejectRadio.checked;
  reason.required = reject;
  reason.disabled = !reject;
}

export async function submitReview() {
  const submission = state.queueState.current;
  if (!submission) {
    showPanelError(t('kyc.panel.noSelection'));
    return;
  }
  const actionRadio = document.querySelector('input[name="kyc-panel-action"]:checked');
  const action = actionRadio ? actionRadio.value : 'approve';
  const reasonEl = document.getElementById('kyc-panel-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';

  if (action === 'reject' && !reason) {
    showPanelError(t('kyc.panel.reasonRequired'));
    return;
  }

  try {
    const res = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: submission.user_id,
        action,
        reason,
      }),
    });

    if (!res.ok) {
      let msg = t('kyc.panel.approveFailed', { status: res.status });
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      showPanelError(msg);
      return;
    }

    closeReviewPanel();
    loadQueue();
  } catch (e) {
    if (isUnauthorized(e)) return;
    showPanelError(t('kyc.panel.reviewFailed', { error: e.message || 'Network error' }));
  }
}

function showPanelError(msg) {
  const err = document.getElementById('kyc-panel-error');
  if (err) {
    err.textContent = msg;
    err.hidden = false;
  }
}

export async function openDocument(signedUrl) {
  try {
    const viewToken = new URL(signedUrl, location.href).searchParams.get('token');
    const res = await api(`/api/documents/view?token=${encodeURIComponent(viewToken)}`);
    if (!res.ok) {
      alert(`Document could not be loaded (HTTP ${res.status})`);
      return;
    }
    const url = safeBlobUrl(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (isUnauthorized(e)) return;
    alert(`Failed to open document: ${e.message || 'Network error'}`);
  }
}

export function safeBlobUrl(blob) {
  // Documents and attachments are opened from blob: URLs, which inherit this
  // origin. Only render types that cannot run script; anything else is
  // handed to the browser as a download.
  const inlineBlobTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  const type = inlineBlobTypes.includes(blob.type) ? blob.type : 'application/octet-stream';
  return URL.createObjectURL(new Blob([blob], { type }));
}

// toggleShortcutsHint shows/hides the keyboard hint line under the table.
export function toggleShortcutsHint() {
  const hint = document.getElementById('queue-shortcuts-hint');
  if (!hint) return;
  hint.hidden = !hint.hidden;
  if (!hint.hidden) hint.textContent = t('kyc.shortcuts.hint');
}

// ensurePanelForSelection opens the review panel for the current selection
// (the approve/reject shortcuts act on it even when it was not open yet).
function ensurePanelForSelection(rows) {
  const current = state.queueState.selectedIndex;
  if (!state.queueState.current && current >= 0 && rows[current]) {
    openReviewPanel(rows[current]);
  }
}

// onQueueShortcut implements the queue keyboard shortcuts. Typing in a form
// field is never hijacked, and the shortcuts only apply while the queue page
// is visible.
export function onQueueShortcut(e) {
  const section = document.getElementById('queue-section');
  if (!section || section.hidden) return;
  const target = e.target || {};
  const tag = target.tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const key = e.key;
  if (key === 'ArrowDown' || key === 'j') {
    moveSelection(1);
    if (e.preventDefault) e.preventDefault();
    return;
  }
  if (key === 'ArrowUp' || key === 'k') {
    moveSelection(-1);
    if (e.preventDefault) e.preventDefault();
    return;
  }
  if (key === 'Enter') {
    const rows = state.queueState.submissions;
    const current = state.queueState.selectedIndex;
    if (rows.length && current >= 0) openReviewPanel(rows[current]);
    else if (rows.length) selectQueueRow(0, true);
    return;
  }
  if (key === 'a' || key === 'A') {
    const rows = state.queueState.submissions;
    if (!rows.length) return;
    if (state.queueState.selectedIndex < 0) selectQueueRow(0, true);
    ensurePanelForSelection(rows);
    const approve = document.querySelector('input[name="kyc-panel-action"][value="approve"]');
    if (approve) approve.checked = true;
    syncReasonRequirement();
    submitReview();
    return;
  }
  if (key === 'r' || key === 'R') {
    const rows = state.queueState.submissions;
    if (!rows.length) return;
    if (state.queueState.selectedIndex < 0) selectQueueRow(0, true);
    ensurePanelForSelection(rows);
    const reject = document.querySelector('input[name="kyc-panel-action"][value="reject"]');
    if (reject) reject.checked = true;
    syncReasonRequirement();
    const reason = document.getElementById('kyc-panel-reason');
    if (reason) reason.focus();
    return;
  }
  if (key === 'Escape') {
    closeReviewPanel();
    return;
  }
  if (key === '?') toggleShortcutsHint();
}

// wire attaches the queue page's listeners (called once by main).
export function wire() {
  const refresh = document.getElementById('refresh-queue-btn');
  if (refresh) refresh.addEventListener('click', loadQueue);

  const closeBtn = document.getElementById('kyc-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', closeReviewPanel);

  const submitBtn = document.getElementById('kyc-panel-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitReview);

  for (const radio of document.querySelectorAll('input[name="kyc-panel-action"]')) {
    radio.addEventListener('change', syncReasonRequirement);
  }

  document.addEventListener('keydown', onQueueShortcut);

  const hint = document.getElementById('queue-shortcuts-hint');
  if (hint) {
    hint.textContent = t('kyc.shortcuts.hint');
    hint.hidden = true;
  }
}
