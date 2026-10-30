// DOM helpers.
//
// XSS rule (CONSOLE-SEC): values that come from the API (names, emails, ids,
// notes, reasons, ticket messages, file names, enums) reach the DOM only
// through textContent — via el() / badge() / detailRow() below. innerHTML is
// kept for static markup with no interpolation. CSS classes are picked from
// fixed maps, never built from API values.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function badge(badgeClass, text) {
  return el('span', `badge ${badgeClass}`, text);
}

export function show(elem) { if (elem) elem.hidden = false; }
export function hide(elem) { if (elem) elem.hidden = true; }

// Badge classes come from a fixed map, never from the API value itself.
export function verificationBadgeClass(status) {
  if (status === 'approved') return 'badge-approved';
  if (status === 'rejected') return 'badge-rejected';
  if (status === 'pending' || status === 'pending_super_admin_approval') return 'badge-pending';
  return 'badge-free';
}

export function detailRow(label, value, valueTag = 'strong') {
  const row = el('div', 'detail-row');
  row.appendChild(el('span', '', `${label}:`));
  row.appendChild(document.createTextNode(' '));
  row.appendChild(el(valueTag, '', value));
  return row;
}
