// Session: idle sign-out (30 minutes, checked every 30s) and the single
// logout() path used by Sign out, any 401 and the idle timeout.

import state, { resetSessionState } from './state.js';

export const lastActivityKey = 'reviewer_last_activity';

// IDLE sign-out constants (CONSOLE-SEC): a session with no pointer/keyboard
// activity for IDLE_TIMEOUT_MS is signed out (checked every IDLE_CHECK_MS,
// and on page load).
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const IDLE_CHECK_MS = 30 * 1000;

let idleTimer = null;

function clearSessionDom() {
  // Rendered reviewer data must not survive the session in the DOM.
  for (const tbody of document.querySelectorAll('table tbody')) tbody.textContent = '';
  for (const dlg of document.querySelectorAll('dialog')) dlg.close();
  for (const id of ['ticket-chat-messages', 'resolve-dispute-details', 'resolve-ticket-details', 'user-docs-links', 'user-docs-status-bar', 'reviewer-identity']) {
    const node = document.getElementById(id);
    if (node) node.textContent = '';
  }
  for (const input of document.querySelectorAll('input[type="text"], input[type="password"], textarea')) input.value = '';
  for (const b of document.querySelectorAll('.pill')) b.textContent = '0';
  const chatCard = document.getElementById('ticket-chat-card');
  if (chatCard) chatCard.hidden = true;

  const appView = document.getElementById('app-view');
  const loginView = document.getElementById('login-view');
  if (appView) appView.hidden = true;
  if (loginView) loginView.hidden = false;
  const loginError = document.getElementById('login-error');
  if (loginError) {
    loginError.hidden = true;
    loginError.textContent = '';
  }
}

// logout ends the session from any path (Sign out, a 401, idle timeout):
// the token, every sessionStorage key and all in-memory reviewer data go.
export function logout(message) {
  try { sessionStorage.clear(); } catch { /* ignore */ }
  stopIdleWatch();
  resetSessionState();
  clearSessionDom();
  if (message) {
    const err = document.getElementById('login-error');
    if (err) {
      err.textContent = message;
      err.hidden = false;
    }
  }
}

export function markActivity() {
  if (sessionStorage.getItem('reviewer_token')) {
    sessionStorage.setItem(lastActivityKey, String(Date.now()));
  }
}

// checkIdle signs out when the last recorded activity is older than
// IDLE_TIMEOUT_MS. Returns true if it did.
export function checkIdle(now = Date.now()) {
  if (!sessionStorage.getItem('reviewer_token')) return false;
  const last = Number(sessionStorage.getItem(lastActivityKey)) || 0;
  if (now - last < IDLE_TIMEOUT_MS) return false;
  logout(`Signed out after ${IDLE_TIMEOUT_MS / (60 * 1000)} minutes of inactivity.`);
  return true;
}

export function startIdleWatch() {
  stopIdleWatch();
  idleTimer = setInterval(checkIdle, IDLE_CHECK_MS);
}

export function stopIdleWatch() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

// wireActivityListeners registers the passive activity listeners once.
export function wireActivityListeners() {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, markActivity, { passive: true });
  }
}

export function currentReviewer() {
  return state.currentReviewer;
}
