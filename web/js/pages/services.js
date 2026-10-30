// Services marketplace moderation (ADMIN_API § 4): list services with their
// moderation state and act on them — hide, unhide or remove the photo. Every
// action requires a mandatory reason and is audited upstream
// (service.hide / service.unhide / service.photo_remove).
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { show, hide, el, badge } from '../core/dom.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { tableController, changePage } from '../core/ui/table.js';

addTranslations('services', {
  ar: {
    title: 'خدمات السوق',
    refresh: 'تحديث',
    filter: 'بحث',
    reset: 'مسح',
    empty: 'لا توجد خدمات مطابقة.',
    col: {
      service: 'الخدمة',
      tenant: 'المالك',
      photo: 'الصورة',
      status: 'الظهور',
      action: 'إجراء',
    },
    visible: 'ظاهرة',
    hidden: 'مخفية',
    hasPhoto: 'نعم',
    noPhoto: 'لا',
    viewPhoto: 'عرض الصورة',
    hiddenBy: 'أخفاها',
    hiddenReason: 'سبب الإخفاء',
    hide: 'إخفاء الخدمة',
    unhide: 'إعادة الظهور',
    removePhoto: 'حذف الصورة',
    loadFailed: 'فشل تحميل الخدمات: {error}',
    action: {
      hideTitle: 'إخفاء الخدمة',
      unhideTitle: 'إعادة ظهور الخدمة',
      photoTitle: 'حذف صورة الخدمة',
      reason: 'السبب',
      submit: 'تأكيد',
      close: 'إلغاء',
      required: 'السبب مطلوب.',
      failed: 'فشل تنفيذ الإجراء: {error}',
    },
  },
  en: {
    title: 'Marketplace Services',
    refresh: 'Refresh',
    filter: 'Filter',
    reset: 'Reset',
    empty: 'No matching services found.',
    col: {
      service: 'Service',
      tenant: 'Tenant',
      photo: 'Photo',
      status: 'Visibility',
      action: 'Action',
    },
    visible: 'Visible',
    hidden: 'Hidden',
    hasPhoto: 'Yes',
    noPhoto: 'No',
    viewPhoto: 'View photo',
    hiddenBy: 'Hidden by',
    hiddenReason: 'Hidden reason',
    hide: 'Hide service',
    unhide: 'Unhide service',
    removePhoto: 'Remove photo',
    loadFailed: 'Failed to load services: {error}',
    action: {
      hideTitle: 'Hide service',
      unhideTitle: 'Unhide service',
      photoTitle: 'Remove service photo',
      reason: 'Reason',
      submit: 'Confirm',
      close: 'Cancel',
      required: 'A reason is required.',
      failed: 'Action failed: {error}',
    },
  },
});

// The three moderation actions share one dialog.
const ACTIONS = {
  hide: { title: 'services.action.hideTitle', endpoint: (id) => `/api/services/${encodeURIComponent(id)}/hide` },
  unhide: { title: 'services.action.unhideTitle', endpoint: (id) => `/api/services/${encodeURIComponent(id)}/unhide` },
  photo: { title: 'services.action.photoTitle', endpoint: (id) => `/api/services/${encodeURIComponent(id)}/photo/remove` },
};

export async function loadServices() {
  hide(document.getElementById('services-error'));

  const st = state.servicesState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });
  if (st.tenantId) params.set('tenant_id', st.tenantId);
  if (st.name) params.set('name', st.name);
  if (st.hasPhoto) params.set('has_photo', st.hasPhoto);
  if (st.hidden) params.set('hidden', st.hidden);

  let data;
  try {
    const res = await api(`/api/services?${params.toString()}`);
    if (!res.ok) throw new Error(`services request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('services-error');
    if (err) {
      err.textContent = t('services.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const services = Array.isArray(data.services) ? data.services : [];
  st.total = data.total || services.length;
  st.rows = services;

  const table = tableController({
    tbody: document.querySelector('#services-table tbody'),
    countText: document.getElementById('services-count'),
    pageInfo: document.getElementById('services-page-info'),
    prevBtn: document.getElementById('services-prev-btn'),
    nextBtn: document.getElementById('services-next-btn'),
  });

  table.renderRows({
    rows: services,
    colCount: 5,
    emptyText: t('services.empty'),
    renderRow: serviceRow,
  });

  table.updatePagination({ items: services.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'services' });
}

function serviceRow(service) {
  const tr = document.createElement('tr');

  const nameTd = document.createElement('td');
  nameTd.appendChild(el('strong', '', service.name || '—'));
  nameTd.appendChild(document.createTextNode(' '));
  nameTd.appendChild(el('code', 'id-tag', service.id || ''));
  tr.appendChild(nameTd);

  const tenantTd = document.createElement('td');
  tenantTd.appendChild(el('code', 'id-tag', service.tenant_id || ''));
  tr.appendChild(tenantTd);

  // The photo lives in object storage; the console shows it as a link (the
  // strict CSP only allows same-origin images).
  const photoTd = document.createElement('td');
  if (service.photo_url) {
    const link = document.createElement('a');
    link.href = service.photo_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('services.viewPhoto');
    link.title = service.photo_url;
    photoTd.appendChild(link);
    photoTd.appendChild(document.createTextNode(' '));
    photoTd.appendChild(el('span', 'muted small', t('services.hasPhoto')));
  } else {
    photoTd.appendChild(el('span', 'muted', t('services.noPhoto')));
  }
  tr.appendChild(photoTd);

  const statusTd = document.createElement('td');
  if (service.is_hidden) {
    statusTd.appendChild(badge('badge-suspended', t('services.hidden')));
    if (service.hidden_reason) {
      statusTd.appendChild(document.createElement('br'));
      statusTd.appendChild(el('span', 'reason-note', `${t('services.hiddenReason')}: ${service.hidden_reason}`));
    }
    if (service.hidden_by) {
      statusTd.appendChild(document.createElement('br'));
      statusTd.appendChild(el('span', 'muted small', `${t('services.hiddenBy')}: ${service.hidden_by}`));
    }
  } else {
    statusTd.appendChild(badge('badge-active', t('services.visible')));
  }
  tr.appendChild(statusTd);

  const actionTd = document.createElement('td');
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = service.is_hidden ? 'btn-sm' : 'btn-sm danger';
  toggleBtn.textContent = service.is_hidden ? t('services.unhide') : t('services.hide');
  toggleBtn.addEventListener('click', () => openServiceAction(service, service.is_hidden ? 'unhide' : 'hide'));
  actionTd.appendChild(toggleBtn);

  if (service.photo_url) {
    const photoBtn = document.createElement('button');
    photoBtn.type = 'button';
    photoBtn.className = 'btn-sm danger';
    photoBtn.textContent = t('services.removePhoto');
    photoBtn.addEventListener('click', () => openServiceAction(service, 'photo'));
    actionTd.appendChild(photoBtn);
  }
  tr.appendChild(actionTd);

  return tr;
}

// openServiceAction opens the shared moderation dialog for one action.
export function openServiceAction(service, action) {
  const config = ACTIONS[action];
  if (!config || !service) return;
  state.servicesState.actionTarget = service;
  state.servicesState.actionKind = action;

  const title = document.getElementById('service-action-title');
  if (title) title.textContent = t(config.title);
  const target = document.getElementById('service-action-target');
  if (target) target.textContent = `${service.name || ''} (${service.id || ''})`;
  const reason = document.getElementById('service-action-reason');
  if (reason) reason.value = '';
  hide(document.getElementById('service-action-error'));
  openDialog('service-action-dialog');
}

export async function submitServiceAction() {
  const service = state.servicesState.actionTarget;
  const kind = state.servicesState.actionKind;
  const config = ACTIONS[kind];
  if (!service || !config) return;

  const reasonEl = document.getElementById('service-action-reason');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    const err = document.getElementById('service-action-error');
    if (err) {
      err.textContent = t('services.action.required');
      show(err);
    }
    return;
  }

  try {
    const res = await api(config.endpoint(service.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      let msg = `Action failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('service-action-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    state.servicesState.actionTarget = null;
    state.servicesState.actionKind = null;
    closeDialog('service-action-dialog');
    loadServices();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('service-action-error');
    if (err) {
      err.textContent = t('services.action.failed', { error: e.message || 'Network error' });
      show(err);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-services-btn');
  if (refresh) refresh.addEventListener('click', loadServices);

  const form = document.getElementById('services-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyServiceFilters();
    });
  }
  const reset = document.getElementById('services-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('services-tenant-input').value = '';
    document.getElementById('services-name-input').value = '';
    document.getElementById('services-photo-filter').value = '';
    document.getElementById('services-hidden-filter').value = '';
    applyServiceFilters();
  });

  const prev = document.getElementById('services-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.servicesState, -1, loadServices));
  const next = document.getElementById('services-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.servicesState, +1, loadServices));

  const cancel = document.getElementById('service-action-cancel');
  if (cancel) cancel.addEventListener('click', () => closeDialog('service-action-dialog'));
  const submit = document.getElementById('service-action-submit');
  if (submit) submit.addEventListener('click', submitServiceAction);
}

function applyServiceFilters() {
  const st = state.servicesState;
  st.tenantId = document.getElementById('services-tenant-input').value.trim();
  st.name = document.getElementById('services-name-input').value.trim();
  st.hasPhoto = document.getElementById('services-photo-filter').value;
  st.hidden = document.getElementById('services-hidden-filter').value;
  st.page = 1;
  loadServices();
}
