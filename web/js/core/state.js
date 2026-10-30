// Mutable console state shared across page modules and reset by logout.
// Page modules never hold module-level state: everything lives here so the
// session reset is complete and tests can reset between cases.

const accountsState = {
  page: 1,
  limit: 15,
  search: '',
  role: '',
  status: '',
  total: 0,
  rows: [],
};

const jobsState = {
  page: 1,
  limit: 20,
  jobId: '',
  customerId: '',
  status: '',
  from: '',
  to: '',
  total: 0,
  rows: [],
  currentId: '',
  cancelTarget: null,
  codTarget: null,
};

const servicesState = {
  page: 1,
  limit: 20,
  tenantId: '',
  name: '',
  hasPhoto: '',
  hidden: '',
  total: 0,
  rows: [],
  actionTarget: null,
  actionKind: null,
};

const reconciliationState = {
  page: 1,
  limit: 15,
  total: 0,
};

const subscriptionsState = {
  page: 1,
  limit: 15,
  search: '',
  status: '',
  total: 0,
};

const ticketsState = {
  page: 1,
  limit: 15,
  search: '',
  status: '',
  total: 0,
};

const payoutsState = {
  page: 1,
  limit: 15,
  status: '',
  total: 0,
};

const claimsState = {
  page: 1,
  limit: 15,
  total: 0,
};

const queueState = {
  submissions: [],
  selectedIndex: -1,
  current: null,
};

const state = {
  currentReviewer: null,
  activeChatWs: null,
  activeChatTicket: null,
  // Dialog targets
  dialogUser: null,      // KYC review submission
  targetAccount: null,
  targetDispute: null,
  targetSub: null,
  targetTicket: null,
  activeRejectPayout: null,
  currentUserDocsTarget: null,
  lastUserDocsReason: '',
  // Page states
  queueState,
  jobsState,
  servicesState,
  accountsState,
  reconciliationState,
  subscriptionsState,
  ticketsState,
  payoutsState,
  claimsState,
  // Overview counters (refreshed by the shell)
  overview: null,
  // True once the shell has been booted (login visible vs app visible).
  booted: false,
};

// resetSessionState clears every session-bound value; used by logout() and by
// tests between cases. Rendered DOM data is wiped separately by logout.
export function resetSessionState() {
  state.currentReviewer = null;
  if (state.activeChatWs) {
    try { state.activeChatWs.close(); } catch { /* ignore */ }
  }
  state.activeChatWs = null;
  state.activeChatTicket = null;
  state.dialogUser = null;
  state.targetAccount = null;
  state.targetDispute = null;
  state.targetSub = null;
  state.targetTicket = null;
  state.activeRejectPayout = null;
  state.currentUserDocsTarget = null;
  state.lastUserDocsReason = '';
  Object.assign(queueState, { submissions: [], selectedIndex: -1, current: null });
  Object.assign(servicesState, {
    page: 1, tenantId: '', name: '', hasPhoto: '', hidden: '', total: 0,
    rows: [], actionTarget: null, actionKind: null,
  });
  Object.assign(jobsState, {
    page: 1, jobId: '', customerId: '', status: '', from: '', to: '', total: 0,
    rows: [], currentId: '', cancelTarget: null, codTarget: null,
  });
  Object.assign(accountsState, { page: 1, search: '', role: '', status: '', total: 0, rows: [] });
  Object.assign(reconciliationState, { page: 1, total: 0 });
  Object.assign(subscriptionsState, { page: 1, search: '', status: '', total: 0 });
  Object.assign(ticketsState, { page: 1, search: '', status: '', total: 0 });
  Object.assign(payoutsState, { page: 1, status: '', total: 0 });
  Object.assign(claimsState, { page: 1, total: 0 });
  state.overview = null;
  state.booted = false;
}

export default state;
