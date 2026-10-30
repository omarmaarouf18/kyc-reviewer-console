// i18n: Arabic (default, RTL) and English, remembered per browser in
// localStorage (wrapped in try/catch — storage can be unavailable).
//
// Every user-visible string goes through t(). Keys are dotted and flat
// ("nav.overview", "kyc.rejectReason") and grouped by area; page modules add
// their area on init via addTranslations(). Unknown keys degrade to a readable
// fallback (the key's last segment) instead of rendering nothing.

const STORAGE_KEY = 'console_lang';

export const languages = { ar: 'العربية', en: 'English' };

const dict = {
  ar: {},
  en: {},
};

let current = 'ar';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function detectLanguage() {
  const saved = storageGet(STORAGE_KEY);
  return saved === 'en' ? 'en' : 'ar';
}

export function setLanguage(lang) {
  current = lang === 'en' ? 'en' : 'ar';
  storageSet(STORAGE_KEY, current);
  applyDirection();
}

export function getLanguage() {
  return current;
}

// For tests: language state is module-level, tests reset it explicitly.
export function _resetLanguage(lang) {
  current = lang === 'en' ? 'en' : 'ar';
}

// applyDirection sets the document direction and language attribute so the
// whole console reads RTL (Arabic, default) or LTR (English).
export function applyDirection() {
  const dir = current === 'ar' ? 'rtl' : 'ltr';
  if (typeof document !== 'undefined') {
    document.documentElement.dir = dir;
    document.documentElement.lang = current;
  }
}

// t(key) resolves e.g. t('nav.overview'); params substitutes {name} tokens.
export function t(key, params) {
  let text = dict[current][key] ?? dict.en[key];
  if (text === undefined) text = String(key).split('.').pop().replace(/_/g, ' ');
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

// addTranslations(area, { ar: {...}, en: {...} }) merges one area's strings.
// Nested groups are flattened into dotted keys, so { col: { user: 'User' } }
// under area 'accounts' becomes 'accounts.col.user'.
export function addTranslations(area, translations) {
  for (const lang of ['ar', 'en']) {
    const src = translations[lang] || {};
    for (const [k, v] of Object.entries(src)) {
      const key = k.startsWith('.') ? k : `${area}.${k}`;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flattenInto(dict[lang], key, v);
      } else {
        dict[lang][key] = v;
      }
    }
  }
}

function flattenInto(target, prefix, group) {
  for (const [k, v] of Object.entries(group)) {
    const key = `${prefix}.${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenInto(target, key, v);
    else target[key] = v;
  }
}
