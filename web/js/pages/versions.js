// App version policy (ADMIN_API § 11): the minimum supported mobile client
// version, the latest release and the enforced store download URL.
//
// The policy lives in the api-gateway, which only answers on the internal
// network and only with the internal-CA client certificate — the console
// reaches it through the proxy (GATEWAY_INTERNAL_URL). Updating the policy
// needs a mandatory reason (the gateway writes a version.update audit record).
//
// XSS rule: every API value reaches the DOM through textContent only.

import { api, isUnauthorized } from '../core/api.js';
import { show, hide, el } from '../core/dom.js';
import { addTranslations, t } from '../core/i18n.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { toast } from '../core/ui/toast.js';

addTranslations('versions', {
  ar: {
    title: 'إصدارات التطبيق',
    refresh: 'تحديث',
    update: 'تحديث سياسة الإصدارات',
    loadFailed: 'فشل تحميل سياسة الإصدارات: {error}',
    unavailable: 'سياسة الإصدارات غير متاحة.',
    latest: 'أحدث إصدار',
    minimum: 'أقل إصدار مدعوم',
    enforce: 'إلزام الحد الأدنى',
    enforced: 'مُفعّل',
    notEnforced: 'غير مُفعّل',
    download: 'رابط التحميل',
    revision: 'المراجعة',
    updated: 'آخر تحديث',
    fields: {
      latest: 'أحدث إصدار',
      minimum: 'أقل إصدار مدعوم',
      enforce: 'إلزام الحد الأدنى',
      download: 'رابط التحميل',
      revision: 'المراجعة',
      updated: 'آخر تحديث',
    },
    dialog: {
      title: 'تحديث سياسة الإصدارات',
      target: 'السياسة الحالية: {latest} (الحد الأدنى {minimum})',
      latest: 'أحدث إصدار',
      minimum: 'أقل إصدار مدعوم',
      download: 'رابط المتجر',
      enforce: 'إلزام الحد الأدنى',
      reason: 'سبب التحديث',
      submit: 'حفظ السياسة',
      close: 'إلغاء',
      required: 'سبب التحديث مطلوب.',
      failed: 'فشل تحديث سياسة الإصدارات: {error}',
      done: 'تم تحديث سياسة الإصدارات.',
    },
  },
  en: {
    title: 'App versions',
    refresh: 'Refresh',
    update: 'Update version policy',
    loadFailed: 'Failed to load the version policy: {error}',
    unavailable: 'The version policy is unavailable.',
    latest: 'Latest version',
    minimum: 'Minimum supported version',
    enforce: 'Enforce minimum version',
    enforced: 'enforced',
    notEnforced: 'not enforced',
    download: 'Download URL',
    revision: 'Revision',
    updated: 'Updated',
    fields: {
      latest: 'Latest version',
      minimum: 'Minimum supported version',
      enforce: 'Enforce minimum version',
      download: 'Download URL',
      revision: 'Revision',
      updated: 'Updated',
    },
    dialog: {
      title: 'Update the version policy',
      target: 'Current policy: {latest} (minimum {minimum})',
      latest: 'Latest version',
      minimum: 'Minimum supported version',
      download: 'Store URL',
      enforce: 'Enforce minimum version',
      reason: 'Reason for the update',
      submit: 'Save policy',
      close: 'Cancel',
      required: 'A reason is required to update the policy.',
      failed: 'Failed to update the version policy: {error}',
      done: 'The version policy was updated.',
    },
  },
});

// loadVersions fetches the active version policy and renders it.
export async function loadVersions() {
  hide(document.getElementById('versions-error'));

  let data;
  try {
    const res = await api('/api/version');
    if (!res.ok) throw new Error(`version request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('versions-error');
    if (err) {
      err.textContent = t('versions.loadFailed', { error: e.message });
      show(err);
    }
    const card = document.getElementById('versions-card');
    if (card) {
      card.textContent = '';
      card.appendChild(el('p', 'muted', t('versions.unavailable')));
    }
    return;
  }

  const policy = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const card = document.getElementById('versions-card');
  if (!card) return;
  card.textContent = '';

  const grid = el('div', 'version-grid');
  const fields = [
    ['versions.fields.latest', policy.latest_version || '—'],
    ['versions.fields.minimum', policy.minimum_supported_version || '—'],
    ['versions.fields.enforce', policy.enforce_minimum_version ? t('versions.enforced') : t('versions.notEnforced')],
    ['versions.fields.revision', policy.revision === undefined || policy.revision === null ? '—' : String(policy.revision)],
    ['versions.fields.updated', policy.updated_at ? new Date(policy.updated_at).toLocaleString() : '—'],
  ];
  for (const [labelKey, value] of fields) {
    const cell = el('div', 'version-cell');
    cell.appendChild(el('span', 'muted small', t(labelKey)));
    cell.appendChild(el('strong', '', value));
    grid.appendChild(cell);
  }
  card.appendChild(grid);

  const download = el('div', 'version-cell version-cell-wide');
  download.appendChild(el('span', 'muted small', t('versions.fields.download')));
  if (policy.download_url) {
    // The store URL is an external https link: noopener/noreferrer keep the
    // console window safe.
    const link = document.createElement('a');
    link.href = policy.download_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = policy.download_url;
    download.appendChild(link);
  } else {
    download.appendChild(el('strong', '', '—'));
  }
  card.appendChild(download);
}

// openVersionUpdateDialog opens the policy editor, pre-filled with the
// current values.
export function openVersionUpdateDialog(policy) {
  const target = document.getElementById('version-update-target');
  if (target) {
    target.textContent = t('versions.dialog.target', {
      latest: policy.latest_version || '—',
      minimum: policy.minimum_supported_version || '—',
    });
  }
  const latest = document.getElementById('version-latest-input');
  if (latest) latest.value = policy.latest_version || '';
  const minimum = document.getElementById('version-minimum-input');
  if (minimum) minimum.value = policy.minimum_supported_version || '';
  const download = document.getElementById('version-download-input');
  if (download) download.value = policy.download_url || '';
  const enforce = document.getElementById('version-enforce-input');
  if (enforce) enforce.checked = !!policy.enforce_minimum_version;
  const reason = document.getElementById('version-reason-input');
  if (reason) reason.value = '';
  hide(document.getElementById('version-update-error'));
  openDialog('version-update-dialog');
}

export async function submitVersionUpdate() {
  const reasonEl = document.getElementById('version-reason-input');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    const err = document.getElementById('version-update-error');
    if (err) {
      err.textContent = t('versions.dialog.required');
      show(err);
    }
    return;
  }

  const latest = document.getElementById('version-latest-input');
  const minimum = document.getElementById('version-minimum-input');
  const download = document.getElementById('version-download-input');
  const enforce = document.getElementById('version-enforce-input');

  const body = {
    reason,
    enforce_minimum_version: enforce ? !!enforce.checked : false,
  };
  if (latest && latest.value.trim()) body.latest_version = latest.value.trim();
  if (minimum && minimum.value.trim()) body.minimum_supported_version = minimum.value.trim();
  if (download && download.value.trim()) body.download_url = download.value.trim();

  try {
    const res = await api('/api/version', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `Version update failed (HTTP ${res.status})`;
      try {
        const payload = await res.json();
        if (payload.message) msg = payload.message;
        else if (payload.error) msg = payload.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('version-update-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    closeDialog('version-update-dialog');
    toast(t('versions.dialog.done'), 'ok');
    loadVersions();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('version-update-error');
    const msg = t('versions.dialog.failed', { error: e.message || 'Network error' });
    if (err) {
      err.textContent = msg;
      show(err);
    } else {
      alert(msg);
    }
  }
}

export function wire() {
  const refresh = document.getElementById('refresh-versions-btn');
  if (refresh) refresh.addEventListener('click', loadVersions);

  const update = document.getElementById('versions-update-btn');
  if (update) {
    update.addEventListener('click', async () => {
      // The editor opens with the current policy, so the form is filled from
      // the same endpoint the page shows.
      try {
        const res = await api('/api/version');
        const policy = res.ok ? await res.json() : {};
        openVersionUpdateDialog(policy || {});
      } catch (e) {
        if (isUnauthorized(e)) return;
        openVersionUpdateDialog({});
      }
    });
  }

  const cancel = document.getElementById('version-update-cancel');
  if (cancel) cancel.addEventListener('click', () => closeDialog('version-update-dialog'));
  const submit = document.getElementById('version-update-submit');
  if (submit) submit.addEventListener('click', submitVersionUpdate);
}
