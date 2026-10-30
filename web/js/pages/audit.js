// Audit viewer (ADMIN_API § 10): the merged admin_audit log of every
// service (auth, user, chat, notification, gateway), newest first.
//
// The response also carries a per-source status map: a source that failed
// inside auth-service is reported as "unavailable" while the other sources'
// records are still returned. The page shows that state instead of pretending
// the log is complete.
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { show, hide, el, badge } from '../core/dom.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';

addTranslations('audit', {
  ar: {
    title: 'سجل التدقيق',
    refresh: 'تحديث',
    filter: 'بحث',
    reset: 'مسح',
    empty: 'لا توجد سجلات مطابقة.',
    loadFailed: 'فشل تحميل سجل التدقيق: {error}',
    col: {
      time: 'الوقت',
      source: 'المصدر',
      actor: 'المراجع',
      action: 'الإجراء',
      target: 'الهدف',
      reason: 'السبب',
      details: 'التفاصيل',
      request: 'معرّف الطلب',
    },
    sources: {
      title: 'حالة المصادر',
      ok: 'متاح',
      unavailable: 'غير متاح',
      unknown: 'غير معروف',
    },
    noReason: '—',
  },
  en: {
    title: 'Audit log',
    refresh: 'Refresh',
    filter: 'Filter',
    reset: 'Reset',
    empty: 'No matching audit records.',
    loadFailed: 'Failed to load the audit log: {error}',
    col: {
      time: 'Time',
      source: 'Source',
      actor: 'Reviewer',
      action: 'Action',
      target: 'Target',
      reason: 'Reason',
      details: 'Details',
      request: 'Request ID',
    },
    sources: {
      title: 'Source status',
      ok: 'ok',
      unavailable: 'unavailable',
      unknown: 'unknown',
    },
    noReason: '—',
  },
});

// loadAudit loads the merged audit log with the current filters.
export async function loadAudit() {
  hide(document.getElementById('audit-error'));

  const st = state.auditState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });
  if (st.actor) params.set('actor_id', st.actor);
  if (st.action) params.set('action', st.action);
  if (st.target) params.set('target_id', st.target);
  if (st.from) params.set('from', st.from);
  if (st.to) params.set('to', st.to);

  let data;
  try {
    const res = await api(`/api/audit?${params.toString()}`);
    if (!res.ok) throw new Error(`audit request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('audit-error');
    if (err) {
      err.textContent = t('audit.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  st.total = data.total || 0;
  st.rows = entries;

  renderSources(data.sources);

  const table = tableController({
    tbody: document.querySelector('#audit-table tbody'),
    countText: document.getElementById('audit-count'),
    pageInfo: document.getElementById('audit-page-info'),
    prevBtn: document.getElementById('audit-prev-btn'),
    nextBtn: document.getElementById('audit-next-btn'),
  });

  table.renderRows({
    rows: entries,
    colCount: 8,
    emptyText: t('audit.empty'),
    renderRow: auditRow,
  });

  table.updatePagination({ items: entries.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'records' });
}

// renderSources shows the per-source status (ok / unavailable) so a partial
// log is never mistaken for a complete one.
function renderSources(sources) {
  const strip = document.getElementById('audit-sources');
  if (!strip) return;
  strip.textContent = '';
  if (!sources || typeof sources !== 'object') return;

  strip.appendChild(el('span', 'muted small', `${t('audit.sources.title')}:`));
  for (const [name, status] of Object.entries(sources)) {
    const ok = status === 'ok';
    strip.appendChild(document.createTextNode(' '));
    strip.appendChild(badge(ok ? 'badge-approved' : 'badge-pending', `${name}: ${t(`audit.sources.${ok ? 'ok' : 'unavailable'}`)}`));
  }
}

function auditRow(entry) {
  const tr = document.createElement('tr');

  const timeTd = document.createElement('td');
  timeTd.className = 'muted small';
  timeTd.textContent = entry.created_at ? new Date(entry.created_at).toLocaleString() : '—';
  tr.appendChild(timeTd);

  const sourceTd = document.createElement('td');
  sourceTd.appendChild(el('code', '', entry.source || '—'));
  tr.appendChild(sourceTd);

  const actorTd = document.createElement('td');
  actorTd.appendChild(entry.actor_id ? el('code', '', entry.actor_id) : el('span', 'muted', '—'));
  tr.appendChild(actorTd);

  const actionTd = document.createElement('td');
  actionTd.appendChild(el('code', '', entry.action || '—'));
  tr.appendChild(actionTd);

  const targetTd = document.createElement('td');
  if (entry.target_type || entry.target_id) {
    targetTd.appendChild(el('span', '', entry.target_type || ''));
    if (entry.target_type && entry.target_id) targetTd.appendChild(document.createTextNode(' '));
    if (entry.target_id) targetTd.appendChild(el('code', 'id-tag', entry.target_id));
  } else {
    targetTd.appendChild(el('span', 'muted', '—'));
  }
  tr.appendChild(targetTd);

  const reasonTd = document.createElement('td');
  reasonTd.className = 'small';
  reasonTd.textContent = entry.reason || t('audit.noReason');
  tr.appendChild(reasonTd);

  const detailsTd = document.createElement('td');
  detailsTd.className = 'small muted';
  detailsTd.textContent = entry.details || '';
  tr.appendChild(detailsTd);

  const requestTd = document.createElement('td');
  requestTd.appendChild(entry.request_id ? el('code', 'id-tag', entry.request_id) : el('span', 'muted', '—'));
  tr.appendChild(requestTd);

  return tr;
}

export function wire() {
  const refresh = document.getElementById('refresh-audit-btn');
  if (refresh) refresh.addEventListener('click', loadAudit);

  const form = document.getElementById('audit-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyAuditFilters();
    });
  }
  const reset = document.getElementById('audit-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('audit-actor-input').value = '';
    document.getElementById('audit-action-input').value = '';
    document.getElementById('audit-target-input').value = '';
    document.getElementById('audit-from-input').value = '';
    document.getElementById('audit-to-input').value = '';
    applyAuditFilters();
  });

  const prev = document.getElementById('audit-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.auditState, -1, loadAudit));
  const next = document.getElementById('audit-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.auditState, +1, loadAudit));
}

function applyAuditFilters() {
  const st = state.auditState;
  st.actor = document.getElementById('audit-actor-input').value.trim();
  st.action = document.getElementById('audit-action-input').value.trim();
  st.target = document.getElementById('audit-target-input').value.trim();
  st.from = document.getElementById('audit-from-input').value;
  st.to = document.getElementById('audit-to-input').value;
  st.page = 1;
  loadAudit();
}
