// User KYC documents dialog (admin access with mandatory audit reason) —
// shared by the Accounts page and the ticket chat. The user-documents POST
// carries the reason in the JSON body per the ADMIN API contract; the console
// proxy keeps using the transitional GET with query parameters.

import { api, isUnauthorized } from '../core/api.js';
import { badge, el, show, hide, verificationBadgeClass } from '../core/dom.js';
import { upper } from '../core/format.js';
import state from '../core/state.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { openDocument } from './kyc.js';

export function openUserDocsDialog(user) {
  state.currentUserDocsTarget = user;
  state.lastUserDocsReason = '';
  const dlg = document.getElementById('user-docs-dialog');
  const targetP = document.getElementById('user-docs-target');
  targetP.textContent = `User: ${user.username || user.email || user.id} (ID: ${user.id})`;

  document.getElementById('user-docs-reason').value = '';
  hide(document.getElementById('user-docs-reason-error'));
  hide(document.getElementById('user-docs-error'));
  show(document.getElementById('user-docs-reason-form'));
  hide(document.getElementById('user-docs-results'));
  document.getElementById('user-docs-links').textContent = '';

  dlg.showModal();
}

export async function retrieveUserDocs(user, reason) {
  const reasonError = document.getElementById('user-docs-reason-error');
  const resultsError = document.getElementById('user-docs-error');
  hide(reasonError);
  hide(resultsError);

  const cleanReason = (reason || '').trim();
  if (!cleanReason) {
    reasonError.textContent = 'Reason is mandatory for retrieving KYC documents.';
    show(reasonError);
    return;
  }
  if (cleanReason.length > 1000) {
    reasonError.textContent = 'Reason cannot exceed 1000 characters.';
    show(reasonError);
    return;
  }

  const fetchBtn = document.getElementById('user-docs-fetch-btn');
  const refreshBtn = document.getElementById('user-docs-refresh-btn');
  fetchBtn.disabled = true;
  refreshBtn.disabled = true;

  try {
    const res = await api(`/api/documents/user?user_id=${encodeURIComponent(user.id)}&reason=${encodeURIComponent(cleanReason)}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error || `HTTP ${res.status}`;
      reasonError.textContent = `Failed to retrieve documents: ${msg}`;
      show(reasonError);
      resultsError.textContent = `Failed to retrieve documents: ${msg}`;
      show(resultsError);
      return;
    }

    state.lastUserDocsReason = cleanReason;
    const data = await res.json();

    hide(document.getElementById('user-docs-reason-form'));
    show(document.getElementById('user-docs-results'));

    const statusBar = document.getElementById('user-docs-status-bar');
    statusBar.textContent = '';
    for (const [i, [label, status]] of [['KYC Status', data.kyc_status], ['KYE Status', data.kye_status]].entries()) {
      if (i > 0) statusBar.appendChild(document.createTextNode(' | '));
      statusBar.appendChild(el('strong', '', `${label}:`));
      statusBar.appendChild(document.createTextNode(' '));
      statusBar.appendChild(badge(verificationBadgeClass(status), upper(status, 'none')));
    }

    const linksContainer = document.getElementById('user-docs-links');
    linksContainer.textContent = '';

    const slots = [
      ['ID Front', data.id_front_url],
      ['ID Back', data.id_back_url],
      ['Selfie', data.selfie_url],
      ['Business Proof', data.business_proof_url],
    ].filter(([, url]) => url);

    const emptyP = document.getElementById('user-docs-empty');
    if (slots.length === 0) {
      show(emptyP);
    } else {
      hide(emptyP);
      for (const [label, url] of slots) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-sm';
        btn.textContent = `View ${label}`;
        btn.style.margin = '0.35rem';
        btn.addEventListener('click', () => openDocument(url));
        linksContainer.appendChild(btn);
      }
    }

    if (data.document_errors && data.document_errors.length > 0) {
      resultsError.textContent = data.document_errors.join(', ');
      show(resultsError);
    }
  } catch (err) {
    if (isUnauthorized(err)) return;
    reasonError.textContent = `Network error: ${err.message}`;
    show(reasonError);
  } finally {
    fetchBtn.disabled = false;
    refreshBtn.disabled = false;
  }
}

export function wire() {
  const fetchBtn = document.getElementById('user-docs-fetch-btn');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', () => {
      const reason = document.getElementById('user-docs-reason').value;
      if (state.currentUserDocsTarget) {
        retrieveUserDocs(state.currentUserDocsTarget, reason);
      }
    });
  }

  const refreshBtn = document.getElementById('user-docs-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (state.currentUserDocsTarget) {
        retrieveUserDocs(state.currentUserDocsTarget, state.lastUserDocsReason);
      }
    });
  }

  for (const id of ['user-docs-reason-cancel', 'user-docs-close']) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => closeDialog('user-docs-dialog'));
  }
}
