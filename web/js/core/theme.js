// Theme: light (default) and dark, remembered per browser in localStorage
// (wrapped in try/catch — storage can be unavailable). The token sets live in
// style.css: :root carries the light values, html[data-theme="dark"] the dark
// values (design system FE-DS / BRAND_IDENTITY: navy #0D1321, gold #FFC107).

const STORAGE_KEY = 'console_theme';

export const themes = ['light', 'dark'];

// In-memory current theme: storage is the initial source, then toggling keeps
// working even when persistence is unavailable (private mode, tests).
let current = null;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function detectTheme() {
  const saved = storageGet(STORAGE_KEY);
  return saved === 'dark' ? 'dark' : 'light';
}

export function getTheme() {
  if (current === null) current = detectTheme();
  return current;
}

function setThemeState(theme) {
  current = theme === 'dark' ? 'dark' : 'light';
  storageSet(STORAGE_KEY, current);
  applyTheme(current);
}

export function setTheme(theme) {
  setThemeState(theme === 'dark' ? 'dark' : 'light');
}

// For tests: theme state is module-level, tests reset it explicitly.
export function _resetTheme(theme) {
  current = theme === 'dark' ? 'dark' : 'light';
}

// applyTheme sets html[data-theme]; CSS picks the token set from it.
export function applyTheme(theme) {
  current = theme === 'dark' ? 'dark' : 'light';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = current;
  }
}

// wireThemeToggle hooks the header button: next click flips the visible theme.
export function wireThemeToggle(btn) {
  if (!btn) return;
  const label = () => {
    btn.textContent = getTheme() === 'dark' ? '☀' : '☾';
    btn.title = getTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  };
  label();
  btn.addEventListener('click', () => setTheme(getTheme() === 'dark' ? 'light' : 'dark') || label());
}
