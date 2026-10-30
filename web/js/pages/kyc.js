// KYC / KYB / KYE review queue (ADR-0021): pending submissions, documents,
// approve / reject.

import { api, isUnauthorized } from '../core/api.js';
import { addTranslations } from '../core/i18n.js';
import state from '../core/state.js';
import { show } from '../core/dom.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';

// The queue page: string table (Arabic first, English mirrored) in i18n.js.
addTranslations('kyc', {
  ar: {
    page: 'قيد المراجعة',
  },
  en: {
    page: 'Pending Submissions',
  },
});

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

  for (const s of submissions) tbody.appendChild(queueRow(s));
}

function queueRow(s) {
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

  return tr;
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

export function openReviewDialog(submission) {
  state.dialogUser = submission;
  document.getElementById('review-target').textContent =
    `${submission.username} (${submission.email}) — ${submission.role}`;
  document.getElementById('reason').value = '';
  document.getElementById('review-error').hidden = true;
  const rejectRadio = document.querySelector('input[name="action"][value="reject"]');
  rejectRadio.checked = true;
  syncReasonRequirement();
  openDialog('review-dialog');
}

export function syncReasonRequirement() {
  const reject = document.querySelector('input[name="action"][value="reject"]').checked;
  const reason = document.getElementById('reason');
  reason.required = reject;
  reason.disabled = !reject;
}

export async function submitReview() {
  const action = document.querySelector('input[name="action"]:checked').value;
  const reason = document.getElementById('reason').value.trim();

  if (action === 'reject' && !reason) {
    showReviewError('A rejection requires a reason.');
    return;
  }

  try {
    const res = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: state.dialogUser.user_id,
        action,
        reason,
      }),
    });

    if (!res.ok) {
      let msg = `Review failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      showReviewError(msg);
      return;
    }

    closeDialog('review-dialog');
    loadQueue();
  } catch (e) {
    if (isUnauthorized(e)) return;
    showReviewError(`Review failed: ${e.message || 'Network error'}`);
  }
}

function showReviewError(msg) {
  const err = document.getElementById('review-error');
  if (err) {
    err.textContent = msg;
    err.hidden = false;
  }
}

// wire attaches the queue page's static-HTML listeners (called once by main).
export function wire() {
  const refresh = document.getElementById('refresh-queue-btn');
  if (refresh) refresh.addEventListener('click', loadQueue);
  const cancelBtn = document.getElementById('review-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog('review-dialog'));
  const submitBtn = document.getElementById('review-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitReview);
  for (const radio of document.querySelectorAll('input[name="action"]')) {
    radio.addEventListener('change', syncReasonRequirement);
  }
}

