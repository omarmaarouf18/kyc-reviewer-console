// Dialogs: static <dialog> helper plus a generic confirm-with-reason builder
// used by pages whose confirmations are built dynamically (jobs, services,
// subscriptions). All text reaches the DOM through textContent.

import { el, show, hide } from '../dom.js';

export function openDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg) dlg.showModal();
  return dlg;
}

export function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg) dlg.close();
}

// confirmWithReason opens a reason dialog and calls onConfirm({reason}) on
// submit. It creates its own <dialog> (id dialog-id, unique per page) so
// callers never hand-write dialog markup.
//
// options: { id, title, description, danger, warning, submitLabel,
//            reasonRequired, reasonLabel, cancelLabel, reason, onConfirm }
// Returns the open dialog element (already in the DOM).
export function confirmWithReason(options) {
  let dlg = document.getElementById(options.id);
  if (dlg) dlg.remove();
  dlg = el('dialog');
  dlg.id = options.id;
  dlg.setAttribute('data-dynamic', 'true');
  dlg.appendChild(el('h2', '', options.title));

  if (options.description) dlg.appendChild(el('p', 'muted', options.description));
  if (options.warning) dlg.appendChild(el('p', 'warning-callout', options.warning));

  const reasonLabel = el('label', '', options.reasonLabel || 'Reason Required');
  if (options.reasonRequired !== false) {
    reasonLabel.appendChild(el('span', 'required', ' *'));
  }
  dlg.appendChild(reasonLabel);

  const textarea = document.createElement('textarea');
  textarea.id = `${options.id}-reason`;
  textarea.maxLength = 1000;
  textarea.rows = 3;
  textarea.required = options.reasonRequired !== false;
  textarea.placeholder = options.reasonPlaceholder || 'Explain why this is being done';
  textarea.value = options.reason || '';
  dlg.appendChild(textarea);

  const error = el('p', 'error');
  error.hidden = true;
  dlg.appendChild(error);

  const menu = document.createElement('menu');
  const cancel = el('button', 'secondary', options.cancelLabel || 'Cancel');
  cancel.type = 'button';
  const submit = el('button', options.danger ? 'danger' : '', options.submitLabel || 'Confirm');
  submit.type = 'button';
  menu.appendChild(cancel);
  menu.appendChild(submit);
  dlg.appendChild(menu);

  const showError = (message) => {
    error.textContent = message;
    show(error);
  };

  cancel.addEventListener('click', () => dlg.close());
  submit.addEventListener('click', async () => {
    const reason = textarea.value.trim();
    const busyLabel = submit.textContent;
    try {
      submit.disabled = true;
      submit.textContent = `${busyLabel}…`.replace('……', '…');
      if (options.reasonRequired !== false && !reason) {
        showError('A reason is required.');
        return;
      }
      const ok = await options.onConfirm({ reason, dialog: dlg });
      if (ok !== false) dlg.close();
    } catch (e) {
      if (e && e.message === 'unauthorized') return;
      showError(e && e.message ? e.message : 'The action did not complete.');
    } finally {
      submit.disabled = false;
      submit.textContent = busyLabel;
    }
  });

  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

// removeDialogs removes dynamically-created dialogs (logout hygiene).
export function removeDynamicDialogs() {
  for (const dlg of document.querySelectorAll('dialog[data-dynamic="true"]')) dlg.remove();
}

