// Aggregator namespace used by the tests: every module's public functions in
// one import. web/js/app.js has NO side effects and no boot-time DOM work;
// the browser entry with the side effects is web/js/main.js.

export * from './pages/overview.js';
export * from './pages/kyc.js';
export * from './pages/accounts.js';
export * from './pages/jobs.js';
export * from './pages/services.js';
export * from './pages/kycdocs.js';
export * from './pages/disputes.js';
export * from './pages/subscriptions.js';
export * from './pages/tickets.js';
export * from './pages/payouts.js';

export * from './core/dom.js';
export * from './core/format.js';
export * from './core/api.js';
export * from './core/i18n.js';
export * from './core/router.js';
export * from './core/theme.js';
export {
  logout, markActivity, checkIdle,
  startIdleWatch, stopIdleWatch,
  wireActivityListeners, currentReviewer,
  IDLE_TIMEOUT_MS, IDLE_CHECK_MS,
} from './core/session.js';
export { default as state, resetSessionState } from './core/state.js';
export * from './core/ui/table.js';
export * from './core/ui/search.js';
export * from './core/ui/toast.js';
export * from './core/ui/dialog.js';
