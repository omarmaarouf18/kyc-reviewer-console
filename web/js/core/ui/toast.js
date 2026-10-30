// Toast: transient status messages in a fixed corner. Kept minimal — the
// messages carry state only through textContent (never API HTML).

import { el } from '../dom.js';

let host = null;

export function toastHost() {
  if (!host || !document.body.contains(host)) {
    host = el('div', 'toast-host');
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

// toast(message, kind) — kind: 'ok' | 'error' | 'info'
export function toast(message, kind = 'info', ms = 4000) {
  const box = el('div', `toast toast-${kind}`);
  box.textContent = String(message);
  toastHost().appendChild(box);
  setTimeout(() => box.remove(), ms);
  return box;
}
