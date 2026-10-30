// Admin announcements & broadcast notifications (ADMIN_API § 12).
//
// The composer builds the notification-service send contract: a bilingual
// title/body, an audience selection (user / role / tenant / everyone), an
// optional in-app deep link, the mandatory reason and the safety knobs
// (dry run, test user, confirmed audience size, idempotency key).
//
// The service owns the audience lookup, the fan-out, the per-reviewer rate
// limit (5 sends/hour) and the idempotency replay. The console validates the
// request locally before sending it, and it never renders an API value as
// HTML.

import { api, isUnauthorized, readError } from '../core/api.js';
import { show, hide, el, badge } from '../core/dom.js';
import { upper } from '../core/format.js';
import { addTranslations, t } from '../core/i18n.js';
import state from '../core/state.js';
import { tableController, changePage } from '../core/ui/table.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { toast } from '../core/ui/toast.js';

addTranslations('notifications', {
  ar: {
    title: 'الإشعارات والإعلانات',
    refresh: 'تحديث',
    composer: 'إعلان جديد',
    empty: 'لا توجد إشعارات مُرسلة.',
    loadFailed: 'فشل تحميل سجل الإشعارات: {error}',
    col: {
      id: 'معرف الإرسال',
      created: 'تاريخ الإنشاء',
      reviewer: 'المراجع',
      audience: 'الجمهور',
      size: 'الحجم',
      status: 'الحالة',
      delivery: 'التسليم',
      deepLink: 'الرابط',
      action: 'إجراء',
    },
    audience: {
      label: 'الجمهور',
      kind: 'نوع الجمهور',
      user: 'مستخدم محدد',
      role: 'دور',
      tenant: 'تاجر',
      everyone: 'الجميع',
      userId: 'معرف المستخدم',
      email: 'البريد الإلكتروني',
      phone: 'رقم الهاتف',
      roleLabel: 'الدور',
      tenantId: 'معرف التاجر',
      roleCustomers: 'العملاء',
      roleOwners: 'أصحاب المتاجر',
      roleCouriers: 'المندوبون',
    },
    content: {
      title: 'محتوى الإعلان',
      titleAr: 'العنوان (عربي)',
      titleEn: 'العنوان (إنجليزي)',
      bodyAr: 'النص (عربي)',
      bodyEn: 'النص (إنجليزي)',
      deepLink: 'رابط التطبيق الداخلي (اختياري)',
      deepLinkHint: 'المسارات المسموحة: /orders/{id}، /jobs/{id}، /plan، /verification، /tickets/{id}',
      reason: 'سبب الإرسال',
      reasonHint: 'إلزامي (من 1 إلى 1000 حرف)',
    },
    options: {
      label: 'خيارات متقدمة',
      dryRun: 'تجربة فقط (Dry run) — احسب حجم الجمهور دون إرسال',
      testUser: 'إرسال تجريبي لمستخدم محدد',
      testUserId: 'معرف المستخدم للاختبار',
      confirmSize: 'تأكيد حجم الجمهور',
      confirmSizeHint: 'مطلوب عند اختيار «الجميع» أو عندما يكون الجمهور 1000 مستخدم فأكثر',
      idempotency: 'مفتاح التفرّد (Idempotency key)',
      idempotencyHint: 'يمنع الإرسال المزدوج عند النقر المتكرر',
    },
    actions: {
      dryRun: 'حساب حجم الجمهور',
      send: 'إرسال الإعلان',
      sending: 'جارٍ الإرسال…',
      view: 'تفاصيل',
    },
    validation: {
      reason: 'سبب الإرسال مطلوب.',
      title: 'العنوان بالعربية والإنجليزية مطلوب (حتى 120 حرفًا).',
      body: 'النص بالعربية والإنجليزية مطلوب (حتى 1000 حرف).',
      audience: 'اختر جمهورًا صالحًا وأكمل بياناته.',
      deepLink: 'هذا الرابط ليس مسارًا داخليًا مسموحًا.',
    },
    result: {
      dryRun: 'حجم الجمهور المحسوب: {size}',
      queued: 'تم جدولة الإعلان للإرسال ({size} مستخدم).',
      replay: 'هذا الإرسال مكرر (مفتاح التفرّد موجود مسبقًا).',
      confirmation: 'الجمهور يبلغ {size} مستخدمًا — أكّد الحجم ثم أعد الإرسال.',
      confirmFilled: 'تم تعبئة تأكيد الحجم بـ {size}.',
      failed: 'فشل الإرسال: {error}',
      rateLimited: 'تم تجاوز حد الإرسال (5 إشعارات في الساعة). حاول لاحقًا.',
    },
    status: {
      queued: 'في الانتظار',
      sending: 'جارٍ الإرسال',
      done: 'تم',
      failed: 'فشل',
    },
    detail: {
      title: 'تفاصيل الإرسال',
      id: 'معرف الإرسال',
      created: 'تاريخ الإنشاء',
      updated: 'آخر تحديث',
      reviewer: 'المراجع',
      reason: 'السبب',
      audience: 'الجمهور',
      size: 'حجم الجمهور',
      sent: 'تم التسليم',
      failed: 'فشل',
      status: 'الحالة',
      deepLink: 'الرابط الداخلي',
      titles: 'العناوين',
      bodies: 'النصوص',
      test: 'إرسال تجريبي',
      testYes: 'نعم',
      testNo: 'لا',
      error: 'رسالة الخطأ',
      close: 'إغلاق',
    },
  },
  en: {
    title: 'Notifications & announcements',
    refresh: 'Refresh',
    composer: 'New announcement',
    empty: 'No sends yet.',
    loadFailed: 'Failed to load the send history: {error}',
    col: {
      id: 'Send ID',
      created: 'Created at',
      reviewer: 'Reviewer',
      audience: 'Audience',
      size: 'Size',
      status: 'Status',
      delivery: 'Delivery',
      deepLink: 'Deep link',
      action: 'Action',
    },
    audience: {
      label: 'Audience',
      kind: 'Audience kind',
      user: 'Single user',
      role: 'Role',
      tenant: 'Tenant',
      everyone: 'Everyone',
      userId: 'User ID',
      email: 'Email',
      phone: 'Phone',
      roleLabel: 'Role',
      tenantId: 'Tenant ID',
      roleCustomers: 'Customers',
      roleOwners: 'Owners',
      roleCouriers: 'Couriers',
    },
    content: {
      title: 'Announcement content',
      titleAr: 'Title (Arabic)',
      titleEn: 'Title (English)',
      bodyAr: 'Body (Arabic)',
      bodyEn: 'Body (English)',
      deepLink: 'In-app deep link (optional)',
      deepLinkHint: 'Allowed routes: /orders/{id}, /jobs/{id}, /plan, /verification, /tickets/{id}',
      reason: 'Reason for the send',
      reasonHint: 'Required (1-1000 characters)',
    },
    options: {
      label: 'Advanced options',
      dryRun: 'Dry run — resolve the audience size without sending',
      testUser: 'Send a test to one user',
      testUserId: 'Test user ID',
      confirmSize: 'Confirmed audience size',
      confirmSizeHint: 'Mandatory for "everyone" and for audiences of 1,000 users or more',
      idempotency: 'Idempotency key',
      idempotencyHint: 'Prevents a double send when the button is clicked twice',
    },
    actions: {
      dryRun: 'Resolve audience size',
      send: 'Send announcement',
      sending: 'Sending…',
      view: 'Details',
    },
    validation: {
      reason: 'A reason is required.',
      title: 'An Arabic and an English title are required (max 120 characters).',
      body: 'An Arabic and an English body are required (max 1000 characters).',
      audience: 'Pick a valid audience and complete its fields.',
      deepLink: 'This deep link is not an allowed in-app route.',
    },
    result: {
      dryRun: 'Resolved audience size: {size}',
      queued: 'The announcement was queued for delivery ({size} users).',
      replay: 'This send was a replay (the idempotency key already exists).',
      confirmation: 'The audience is {size} users — confirm the size and send again.',
      confirmFilled: 'The confirmed audience size was filled with {size}.',
      failed: 'The send failed: {error}',
      rateLimited: 'The send rate limit was exceeded (5 sends per hour). Try again later.',
    },
    status: {
      queued: 'Queued',
      sending: 'Sending',
      done: 'Done',
      failed: 'Failed',
    },
    detail: {
      title: 'Send details',
      id: 'Send ID',
      created: 'Created at',
      updated: 'Updated at',
      reviewer: 'Reviewer',
      reason: 'Reason',
      audience: 'Audience',
      size: 'Audience size',
      sent: 'Delivered',
      failed: 'Failed',
      status: 'Status',
      deepLink: 'Deep link',
      titles: 'Titles',
      bodies: 'Bodies',
      test: 'Test send',
      testYes: 'yes',
      testNo: 'no',
      error: 'Error message',
      close: 'Close',
    },
  },
});

// STATUS_BADGES maps the service's send status to a fixed badge class (the
// class is never built from the API value).
const STATUS_BADGES = {
  queued: 'badge-pending',
  sending: 'badge-assigned',
  done: 'badge-approved',
  failed: 'badge-rejected',
};

// audienceLabel renders the audience of a send row as text.
function audienceLabel(audience) {
  if (!audience || typeof audience !== 'object') return '—';
  const kind = audience.kind || '';
  switch (kind) {
    case 'user':
      return `${t('notifications.audience.user')}: ${audience.user_id || audience.email || audience.phone || '—'}`;
    case 'role':
      return `${t('notifications.audience.role')}: ${audience.role || '—'}`;
    case 'tenant':
      return `${t('notifications.audience.tenant')}: ${audience.tenant_id || '—'}`;
    case 'everyone':
      return t('notifications.audience.everyone');
    default:
      return kind || '—';
  }
}

// loadNotifications loads the send history.
export async function loadNotifications() {
  hide(document.getElementById('notifications-error'));

  const st = state.notificationsState;
  const params = new URLSearchParams({
    page: String(st.page),
    limit: String(st.limit),
  });

  let data;
  try {
    const res = await api(`/api/notifications/sends?${params.toString()}`);
    if (!res.ok) throw new Error(`notification sends request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('notifications-error');
    if (err) {
      err.textContent = t('notifications.loadFailed', { error: e.message });
      show(err);
    }
    return;
  }

  const sends = Array.isArray(data.sends) ? data.sends : [];
  st.total = data.total || 0;
  st.rows = sends;

  const table = tableController({
    tbody: document.querySelector('#notif-sends-table tbody'),
    countText: document.getElementById('notif-sends-count'),
    pageInfo: document.getElementById('notif-sends-page-info'),
    prevBtn: document.getElementById('notif-sends-prev-btn'),
    nextBtn: document.getElementById('notif-sends-next-btn'),
  });

  table.renderRows({
    rows: sends,
    colCount: 8,
    emptyText: t('notifications.empty'),
    renderRow: sendRow,
  });

  table.updatePagination({ items: sends.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'sends' });
}

function sendRow(send) {
  const tr = document.createElement('tr');

  const idTd = document.createElement('td');
  idTd.appendChild(el('code', 'id-tag', send.id || '—'));
  tr.appendChild(idTd);

  const createdTd = document.createElement('td');
  createdTd.className = 'muted small';
  createdTd.textContent = send.created_at ? new Date(send.created_at).toLocaleString() : '—';
  tr.appendChild(createdTd);

  const reviewerTd = document.createElement('td');
  reviewerTd.appendChild(send.reviewer_id ? el('code', '', send.reviewer_id) : el('span', 'muted', '—'));
  tr.appendChild(reviewerTd);

  const audienceTd = document.createElement('td');
  audienceTd.className = 'small';
  audienceTd.textContent = audienceLabel(send.audience);
  tr.appendChild(audienceTd);

  const sizeTd = document.createElement('td');
  sizeTd.appendChild(el('strong', '', String(send.audience_size ?? 0)));
  tr.appendChild(sizeTd);

  const statusTd = document.createElement('td');
  const status = send.status || '';
  statusTd.appendChild(badge(STATUS_BADGES[status] || 'badge-pending', t(`notifications.status.${status}`) || upper(status)));
  tr.appendChild(statusTd);

  const deliveryTd = document.createElement('td');
  deliveryTd.className = 'small';
  deliveryTd.textContent = `${send.sent_count ?? 0} / ${send.failed_count ?? 0}`;
  tr.appendChild(deliveryTd);

  const linkTd = document.createElement('td');
  linkTd.className = 'small';
  linkTd.textContent = send.deep_link || '—';
  tr.appendChild(linkTd);

  const actionTd = document.createElement('td');
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn-sm';
  viewBtn.textContent = t('notifications.actions.view');
  viewBtn.addEventListener('click', () => openSendDetail(send.id));
  actionTd.appendChild(viewBtn);
  tr.appendChild(actionTd);

  return tr;
}

// buildAudience collects the audience selection from the form.
function buildAudience() {
  const kindEl = document.getElementById('notif-audience-kind');
  const kind = kindEl ? kindEl.value : 'everyone';
  const audience = { kind };
  if (kind === 'user') {
    audience.user_id = valueOf('notif-audience-user-id');
    audience.email = valueOf('notif-audience-email');
    audience.phone = valueOf('notif-audience-phone');
  } else if (kind === 'role') {
    audience.role = valueOf('notif-audience-role');
  } else if (kind === 'tenant') {
    audience.tenant_id = valueOf('notif-audience-tenant-id');
  }
  return audience;
}

function valueOf(id) {
  const node = document.getElementById(id);
  return node ? String(node.value || '').trim() : '';
}

function checkedOf(id) {
  const node = document.getElementById(id);
  return !!(node && node.checked);
}

// buildSendBody assembles the notification-service send contract. It returns
// null when the form is incomplete (the message is shown in the page).
function buildSendBody({ dryRun }) {
  const reason = valueOf('notif-reason');
  if (!reason) {
    showSendError(t('notifications.validation.reason'));
    return null;
  }

  const titleAR = valueOf('notif-title-ar');
  const titleEN = valueOf('notif-title-en');
  if (!titleAR || !titleEN || titleAR.length > 120 || titleEN.length > 120) {
    showSendError(t('notifications.validation.title'));
    return null;
  }

  const bodyAR = valueOf('notif-body-ar');
  const bodyEN = valueOf('notif-body-en');
  if (!bodyAR || !bodyEN || bodyAR.length > 1000 || bodyEN.length > 1000) {
    showSendError(t('notifications.validation.body'));
    return null;
  }

  const audience = buildAudience();
  if (!audienceIsComplete(audience)) {
    showSendError(t('notifications.validation.audience'));
    return null;
  }

  const deepLink = valueOf('notif-deep-link');
  if (deepLink && !deepLinkAllowed(deepLink)) {
    showSendError(t('notifications.validation.deepLink'));
    return null;
  }

  const body = {
    reason,
    audience,
    title: { ar: titleAR, en: titleEN },
    body: { ar: bodyAR, en: bodyEN },
    dry_run: !!dryRun,
  };
  if (deepLink) body.deep_link = deepLink;
  const testUser = valueOf('notif-test-user-id');
  if (testUser) body.test_user_id = testUser;
  const confirmSize = parseInt(valueOf('notif-confirm-size'), 10);
  if (Number.isFinite(confirmSize) && confirmSize > 0) body.confirm_audience_size = confirmSize;
  const idempotency = valueOf('notif-idempotency-key');
  if (idempotency) body.idempotency_key = idempotency;

  return body;
}

// audienceIsComplete mirrors the service's audience contract: a user needs an
// identifier, a role needs its role and a tenant needs its id.
function audienceIsComplete(audience) {
  switch (audience.kind) {
    case 'user':
      return !!(audience.user_id || audience.email || audience.phone);
    case 'role':
      return !!audience.role;
    case 'tenant':
      return !!audience.tenant_id;
    case 'everyone':
      return true;
    default:
      return false;
  }
}

// deepLinkAllowed mirrors the service's allow-list of in-app routes.
function deepLinkAllowed(link) {
  if (!link.startsWith('/') || link.startsWith('//') || link.includes('://')) return false;
  if (/^javascript:/i.test(link)) return false;
  return /^(\/(orders|jobs)\/[a-zA-Z0-9_\-.:]{1,64}|\/tickets(\/[a-zA-Z0-9_\-.:]{1,64})?|\/(plan|plans|subscriptions|subscription)|\/(verification|kyc|kyb|kye))$/.test(link);
}

function showSendError(message) {
  const err = document.getElementById('notif-send-error');
  if (err) {
    err.textContent = message;
    show(err);
  }
}

function clearSendError() {
  const err = document.getElementById('notif-send-error');
  if (err) {
    err.textContent = '';
    hide(err);
  }
}

function showSendResult(message) {
  const result = document.getElementById('notif-send-result');
  if (result) {
    result.textContent = message;
    show(result);
  }
}

// dryRun resolves the audience size without dispatching anything.
export async function dryRunNotification() {
  clearSendError();
  const body = buildSendBody({ dryRun: true });
  if (!body) return;

  try {
    const res = await api('/api/notifications/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const message = await readError(res, 'Dry run failed');
      showSendError(t('notifications.result.failed', { error: message }));
      return;
    }
    const payload = await res.json();
    const size = payload.audience_size ?? 0;
    showSendResult(t('notifications.result.dryRun', { size }));
  } catch (e) {
    if (isUnauthorized(e)) return;
    showSendError(t('notifications.result.failed', { error: e.message || 'Network error' }));
  }
}

// sendNotification queues the announcement for delivery.
export async function sendNotification() {
  clearSendError();
  const body = buildSendBody({ dryRun: false });
  if (!body) return;

  const submit = document.getElementById('notif-send-btn');
  if (submit) {
    submit.disabled = true;
    submit.textContent = t('notifications.actions.sending');
  }

  try {
    const res = await api('/api/notifications/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let payload = {};
      try {
        payload = await res.json();
      } catch { /* keep generic */ }

      // The service asks for a confirmed audience size before a broadcast to
      // "everyone" (or to 1,000+ users): the resolved size is shown and
      // pre-filled, the reviewer confirms it and sends again.
      if (payload.code === 'confirmation_required' || payload.error === 'confirmation_required') {
        const size = payload.resolved_audience_size;
        if (Number.isFinite(size)) {
          const input = document.getElementById('notif-confirm-size');
          if (input) input.value = String(size);
        }
        showSendError(t('notifications.result.confirmation', { size: size ?? '—' }));
        showSendResult(t('notifications.result.confirmFilled', { size: size ?? '—' }));
        return;
      }

      if (res.status === 429 || payload.code === 'rate_limit_exceeded') {
        showSendError(t('notifications.result.rateLimited'));
        return;
      }

      const message = payload.message || payload.error || `HTTP ${res.status}`;
      showSendError(t('notifications.result.failed', { error: message }));
      return;
    }

    const payload = await res.json();
    const size = payload.audience_size ?? 0;
    if (payload.message && /idempotent/i.test(payload.message)) {
      showSendResult(t('notifications.result.replay'));
      toast(t('notifications.result.replay'), 'info');
    } else {
      showSendResult(t('notifications.result.queued', { size }));
      toast(t('notifications.result.queued', { size }), 'ok');
    }
    loadNotifications();
  } catch (e) {
    if (isUnauthorized(e)) return;
    showSendError(t('notifications.result.failed', { error: e.message || 'Network error' }));
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = t('notifications.actions.send');
    }
  }
}

// openSendDetail shows the granular delivery status of one send job.
export async function openSendDetail(id) {
  if (!id) return;
  const details = document.getElementById('notification-send-details');
  if (details) {
    details.textContent = '';
    details.appendChild(el('p', 'muted', '…'));
  }
  openDialog('notification-send-dialog');

  let send;
  try {
    const res = await api(`/api/notifications/sends/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`send detail request failed (${res.status})`);
    send = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    if (details) {
      details.textContent = '';
      details.appendChild(el('p', 'error', t('notifications.loadFailed', { error: e.message })));
    }
    return;
  }

  if (!details) return;
  details.textContent = '';

  const rows = [
    [t('notifications.detail.id'), send.id],
    [t('notifications.detail.created'), send.created_at ? new Date(send.created_at).toLocaleString() : null],
    [t('notifications.detail.updated'), send.updated_at ? new Date(send.updated_at).toLocaleString() : null],
    [t('notifications.detail.reviewer'), send.reviewer_id],
    [t('notifications.detail.reason'), send.reason],
    [t('notifications.detail.audience'), audienceLabel(send.audience)],
    [t('notifications.detail.size'), send.audience_size === undefined ? null : String(send.audience_size)],
    [t('notifications.detail.sent'), send.sent_count === undefined ? null : String(send.sent_count)],
    [t('notifications.detail.failed'), send.failed_count === undefined ? null : String(send.failed_count)],
    [t('notifications.detail.status'), send.status ? t(`notifications.status.${send.status}`) : null],
    [t('notifications.detail.deepLink'), send.deep_link],
    // The service records is_test_send only on some responses; the row is
    // shown when the field is present.
    [t('notifications.detail.test'), send.is_test_send === undefined || send.is_test_send === null
      ? ''
      : (send.is_test_send ? t('notifications.detail.testYes') : t('notifications.detail.testNo'))],
    [t('notifications.detail.error'), send.error_message],
  ];
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const line = el('div', 'detail-line');
    line.appendChild(el('span', 'muted', `${label}: `));
    line.appendChild(el('strong', '', value));
    details.appendChild(line);
  }

  if (send.title_ar || send.title_en) {
    const titles = el('div', 'detail-line');
    titles.appendChild(el('span', 'muted', `${t('notifications.detail.titles')}: `));
    titles.appendChild(el('strong', '', `${send.title_en || ''} / ${send.title_ar || ''}`));
    details.appendChild(titles);
  }
  if (send.body_ar || send.body_en) {
    const bodies = el('div', 'detail-line');
    bodies.appendChild(el('span', 'muted', `${t('notifications.detail.bodies')}: `));
    bodies.appendChild(el('strong', '', `${send.body_en || ''} / ${send.body_ar || ''}`));
    details.appendChild(bodies);
  }
}

// updateAudienceFields shows only the fields the selected audience kind needs.
export function updateAudienceFields() {
  const kindEl = document.getElementById('notif-audience-kind');
  const kind = kindEl ? kindEl.value : 'everyone';
  const groups = {
    user: document.getElementById('notif-audience-user-fields'),
    role: document.getElementById('notif-audience-role-fields'),
    tenant: document.getElementById('notif-audience-tenant-fields'),
  };
  for (const [name, node] of Object.entries(groups)) {
    if (!node) continue;
    if (name === kind) show(node);
    else hide(node);
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-notifications-btn');
  if (refresh) refresh.addEventListener('click', loadNotifications);

  const kind = document.getElementById('notif-audience-kind');
  if (kind) kind.addEventListener('change', updateAudienceFields);
  updateAudienceFields();

  const dryRun = document.getElementById('notif-dry-run-btn');
  if (dryRun) dryRun.addEventListener('click', dryRunNotification);
  const send = document.getElementById('notif-send-btn');
  if (send) send.addEventListener('click', sendNotification);

  const prev = document.getElementById('notif-sends-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.notificationsState, -1, loadNotifications));
  const next = document.getElementById('notif-sends-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.notificationsState, +1, loadNotifications));

  const close = document.getElementById('notification-send-close');
  if (close) close.addEventListener('click', () => closeDialog('notification-send-dialog'));
}
