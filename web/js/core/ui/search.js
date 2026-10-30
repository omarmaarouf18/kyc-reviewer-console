// Search box: toolbar form (input + reset) wired to a page's state object.
// The Enter key submits; Reset clears the input and returns to page 1.

export function createSearchBox({ form, input, resetBtn, onChange }) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onChange(input.value.trim());
  });
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      input.value = '';
      onChange('');
    });
  }
}

// matchesSearch is a small client-side predicate used for in-memory lists.
export function matchesSearch(needle, fields) {
  const q = String(needle || '').toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f || '').toLowerCase().includes(q));
}
