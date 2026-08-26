'use strict';

// Reviewer token is held per-tab (sessionStorage) and sent as X-Reviewer-Token
// on every console API call. The console injects the internal service token
// server-side; it is never visible here.
const tokenKey = 'reviewer_token';
let currentUser = null;

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

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

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

async function loadQueue() {
  hide(document.getElementById('load-error'));
  let submissions;
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(`queue request failed (${res.status})`);
    submissions = await res.json();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const err = document.getElementById('load-error');
    err.textContent = `Failed to load queue: ${e.message}`;
    show(err);
    return;
  }

  const tbody = document.querySelector('#queue-table tbody');
  tbody.textContent = '';
  document.getElementById('queue-count').textContent =
    `${submissions.length} pending`;

  for (const s of submissions) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    who.innerHTML = `<strong></strong><br><span class="muted"></span>`;
    who.querySelector('strong').textContent = s.username || '(no username)';
    who.querySelector('.muted').textContent = s.email || '';
    tr.appendChild(who);

    const role = document.createElement('td');
    role.textContent = s.role === 'owner' ? 'Owner (KYB)' : 'Employee (KYE)';
    tr.appendChild(role);

    const status = document.createElement('td');
    status.textContent = s.kyc_status || s.kye_status || '';
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

// Signed view URLs are consumed server-side by the console proxy; the browser
// fetches bytes through /api/documents/view so headers can be attached.
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

let dialogUser = null;

function openReviewDialog(submission) {
  dialogUser = submission;
  document.getElementById('review-target').textContent =
    `${submission.username} — ${submission.role}`;
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

  // Client-side mirror of the API rule (ADR-0021): rejections need a reason.
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

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tok = document.getElementById('token').value.trim();
  if (!tok) return;

  // Probe the token against the queue endpoint before entering the app.
  sessionStorage.setItem(tokenKey, tok);
  try {
    const res = await api('/api/queue');
    if (!res.ok) throw new Error(res.status === 401 ? null : `HTTP ${res.status}`);
    hide(document.getElementById('login-view'));
    hide(document.getElementById('login-error'));
    show(document.getElementById('app-view'));
    loadQueue();
  } catch (err) {
    sessionStorage.removeItem(tokenKey);
    const el = document.getElementById('login-error');
    el.textContent = err.message === 'unauthorized'
      ? 'Invalid reviewer token.' : `Sign-in failed: ${err.message}`;
    show(el);
  }
});

document.getElementById('logout-btn').addEventListener('click', () => logout());
document.getElementById('refresh-btn').addEventListener('click', loadQueue);
document.getElementById('review-cancel').addEventListener('click',
  () => document.getElementById('review-dialog').close());
document.getElementById('review-submit').addEventListener('click', submitReview);
for (const radio of document.querySelectorAll('input[name="action"]')) {
  radio.addEventListener('change', syncReasonRequirement);
}
