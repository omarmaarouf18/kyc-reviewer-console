// Stuck-COD banner: a shell-level reminder that jobs are waiting for an
// escrow reconciliation (cash collected, escrow still locked). The reviewer
// repairs them from the Jobs page (complete-stuck-cod), so the banner's
// action jumps straight to the jobs filtered by that status.
//
// The banner is fed by the overview figure (stuck_cod_jobs) and by the badge
// refresh, so it stays current while the reviewer works.

import { show, hide } from './dom.js';
import { addTranslations, t } from './i18n.js';
import state from './state.js';
import * as router from './router.js';

addTranslations('codBanner', {
  ar: {
    text: 'يوجد {count} مهمة COD عالقة تنتظر المطابقة.',
    action: 'عرض المهام',
  },
  en: {
    text: '{count} stuck COD job(s) are waiting for reconciliation.',
    action: 'Review jobs',
  },
});

// The banner is fed by the overview counter (the page load and the periodic
// badge refresh). The highest known count wins, so a lagging or temporarily
// unavailable refresh can never hide a real alert; the banner disappears only
// when both reads say zero.
const counts = { overview: 0, refresh: 0 };

// updateCodBanner shows the banner when there is at least one stuck COD job
// and hides it otherwise. A figure the backend could not compute ("unavailable")
// counts as zero and never shows the banner.
export function updateCodBanner(figure, source = 'overview') {
  const banner = document.getElementById('cod-banner');
  if (!banner) return;
  const count = typeof figure === 'number' && Number.isFinite(figure) ? figure : 0;
  counts[source] = count;
  const total = Math.max(counts.overview, counts.refresh);
  if (total <= 0) {
    hide(banner);
    return;
  }
  const text = document.getElementById('cod-banner-text');
  if (text) text.textContent = t('codBanner.text', { count: total });
  show(banner);
}

// wireCodBanner attaches the banner action: it filters the jobs page on the
// reconciliation status and navigates there.
export function wireCodBanner() {
  const btn = document.getElementById('cod-banner-action');
  if (!btn) return;
  btn.addEventListener('click', () => {
    state.jobsState.status = 'escrow_reconciliation_required';
    state.jobsState.page = 1;
    const filter = document.getElementById('jobs-status-filter');
    if (filter) filter.value = 'escrow_reconciliation_required';
    router.navigate('jobs');
  });
}
