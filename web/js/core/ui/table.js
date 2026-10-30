// Table kit: tbody rendering with loading / error / empty states and shared
// pagination controls. Keeps the calm-table look consistent across pages.

import { el } from '../dom.js';

// createTableController binds a <table> tbody plus its pagination controls.
//   rows:  any[...] (already fetched page of data)
//   colCount: number used for spanning full-width rows
//   renderRow: (row) => HTMLTableRowElement
//   meta: { total, page, limit } from the API response
export function tableController({ tbody, countText, pageInfo, prevBtn, nextBtn }) {
  function clear() {
    tbody.textContent = '';
  }

  function loadingRow(colCount, text) {
    clear();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.className = 'empty-state';
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return tr;
  }

  function renderRows({ rows, colCount, emptyText, renderRow }) {
    clear();
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = colCount;
      td.className = 'empty-state';
      td.textContent = emptyText;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const row of rows) tbody.appendChild(renderRow(row));
  }

  // updatePagination refreshes the "Showing X of Y" text, page indicator and
  // prev/next buttons from { items, total, page, limit }.
  function updatePagination({ items, total, page, limit, countNoun }) {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    if (pageInfo) pageInfo.textContent = `Page ${page} of ${totalPages}`;
    if (countText) countText.textContent = `Showing ${items} of ${total} ${countNoun || ''}`.trim();
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
  }

  return { tbody, loadingRow, renderRows, updatePagination, clear };
}

// changePage handles Prev/Next clicks against a mutable { page, total }.
export function changePage(state, dir, reloadFn) {
  if (dir < 0 && state.page > 1) {
    state.page -= 1;
    reloadFn();
  } else if (dir > 0) {
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    if (state.page < totalPages) {
      state.page += 1;
      reloadFn();
    }
  }
}

// sortableHeader returns a th button that re-sorts locally-ordered rows.
export function sortButton(label, key, state, onSort) {
  const th = document.createElement('th');
  const btn = el('button', 'th-sort');
  btn.type = 'button';
  btn.textContent = label;
  btn.textContent += state.sortKey === key ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  btn.addEventListener('click', () => {
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'asc'; }
    onSort();
  });
  th.appendChild(btn);
  return th;
}
