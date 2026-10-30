// Support tickets (ADR-0023 Module B): inbox with status queue, live chat via
// WebSocket subprotocol auth, attachments, resolution with mandatory note.

import { api, isUnauthorized, tokenKey, WS_AUTH_PROTOCOL } from '../core/api.js';
import { el, show, hide, detailRow } from '../core/dom.js';
import { upper, formatBytes } from '../core/format.js';
import state from '../core/state.js';
import { safeBlobUrl, openDocument } from './kyc.js';
import { openUserDocsDialog } from './kycdocs.js';
import { openDialog, closeDialog } from '../core/ui/dialog.js';
import { tableController, changePage } from '../core/ui/table.js';

export async function loadTickets() {
  hide(document.getElementById('tickets-error'));
  const st = state.ticketsState;
  const params = new URLSearchParams();
  if (st.status) params.set('status', st.status);
  if (st.search) params.set('search', st.search);
  params.set('page', st.page);
  params.set('limit', st.limit);

  let data;
  try {
    const res = await api(`/api/tickets?${params.toString()}`);
    if (!res.ok) throw new Error(`tickets request failed (${res.status})`);
    data = await res.json();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('tickets-error');
    err.textContent = `Failed to load tickets: ${e.message}`;
    show(err);
    return;
  }

  const tickets = data.tickets || [];
  st.total = data.total || 0;

  const countBadge = document.getElementById('tickets-badge');
  if (countBadge) countBadge.textContent = `${data.total || tickets.length}`;

  const table = tableController({
    tbody: document.querySelector('#tickets-table tbody'),
    countText: document.getElementById('tickets-count'),
    pageInfo: document.getElementById('tickets-page-info'),
    prevBtn: document.getElementById('tickets-prev-btn'),
    nextBtn: document.getElementById('tickets-next-btn'),
  });

  table.renderRows({
    rows: tickets,
    colCount: 7,
    emptyText: 'No support tickets found.',
    renderRow: ticketRow,
  });

  table.updatePagination({ items: tickets.length, total: st.total, page: st.page, limit: st.limit, countNoun: 'tickets' });
}

function ticketRow(t) {
  const tr = document.createElement('tr');

  // Ticket ID
  const idTd = document.createElement('td');
  idTd.appendChild(el('strong', '', `#${String(t.ticket_id).slice(-8)}`));
  idTd.appendChild(el('br'));
  idTd.appendChild(el('code', 'id-tag', t.ticket_id));
  tr.appendChild(idTd);

  // Customer ID
  const custTd = document.createElement('td');
  custTd.appendChild(el('code', '', t.customer_id));
  tr.appendChild(custTd);

  // Context / Subject
  const contextTd = document.createElement('td');
  contextTd.appendChild(el('strong', '', t.subject || 'Complaint / Support'));
  contextTd.appendChild(el('br'));
  contextTd.appendChild(el('span', 'muted small', t.context_id || 'general'));
  tr.appendChild(contextTd);

  // Status
  const statusTd = document.createElement('td');
  let badgeClass = 'badge-pending';
  if (t.status === 'assigned') badgeClass = 'badge-assigned';
  else if (t.status === 'resolved') badgeClass = 'badge-resolved';
  statusTd.appendChild(el('span', `badge ${badgeClass}`, upper(t.status, 'pending')));
  tr.appendChild(statusTd);

  // Assigned Agent
  const agentTd = document.createElement('td');
  agentTd.appendChild(t.assigned_agent_id ? el('code', '', t.assigned_agent_id) : el('span', 'muted', '(unassigned)'));
  tr.appendChild(agentTd);

  // Created At
  const createdTd = document.createElement('td');
  createdTd.className = 'small';
  createdTd.textContent = t.created_at ? new Date(t.created_at).toLocaleString() : '—';
  tr.appendChild(createdTd);

  // Action
  const actionTd = document.createElement('td');
  if (t.status === 'pending') {
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'btn-sm';
    acceptBtn.textContent = 'Accept Ticket';
    acceptBtn.addEventListener('click', async () => acceptTicket(acceptBtn, t));
    actionTd.appendChild(acceptBtn);
  } else if (t.status === 'assigned') {
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'btn-sm secondary';
    chatBtn.textContent = 'Open Chat';
    chatBtn.style.marginRight = '0.35rem';
    chatBtn.addEventListener('click', () => openTicketChat(t));
    actionTd.appendChild(chatBtn);

    const resolveBtn = document.createElement('button');
    resolveBtn.type = 'button';
    resolveBtn.className = 'btn-sm';
    resolveBtn.textContent = 'Resolve…';
    resolveBtn.addEventListener('click', () => openResolveTicketDialog(t));
    actionTd.appendChild(resolveBtn);
  } else {
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'btn-sm secondary';
    chatBtn.textContent = 'View Chat';
    chatBtn.style.marginRight = '0.35rem';
    chatBtn.addEventListener('click', () => openTicketChat(t));
    actionTd.appendChild(chatBtn);

    const noteSpan = document.createElement('span');
    noteSpan.className = 'muted small';
    noteSpan.textContent = t.resolved_by ? 'By ' + t.resolved_by : 'Resolved';
    actionTd.appendChild(noteSpan);
  }
  tr.appendChild(actionTd);

  return tr;
}

async function acceptTicket(acceptBtn, t) {
  try {
    acceptBtn.disabled = true;
    acceptBtn.textContent = 'Accepting...';
    const res = await api('/api/tickets/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: t.ticket_id }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const updated = data.ticket || { ...t, status: 'assigned' };
    await loadTickets();
    openTicketChat(updated);
  } catch (e) {
    if (isUnauthorized(e)) return;
    alert(`Failed to accept ticket: ${e.message}`);
    acceptBtn.disabled = false;
    acceptBtn.textContent = 'Accept Ticket';
  }
}

export function openResolveTicketDialog(ticket) {
  state.targetTicket = ticket;
  document.getElementById('resolve-ticket-target').textContent = `Ticket ${ticket.ticket_id} (Customer: ${ticket.customer_id})`;
  const detailsEl = document.getElementById('resolve-ticket-details');
  detailsEl.textContent = '';
  detailsEl.appendChild(detailRow('Context ID', ticket.context_id || 'none', 'code'));
  detailsEl.appendChild(detailRow('Assigned Agent', ticket.assigned_agent_id || 'none', 'code'));
  detailsEl.appendChild(detailRow('Created', new Date(ticket.created_at).toLocaleString(), 'span'));
  document.getElementById('resolve-ticket-note').value = '';
  hide(document.getElementById('resolve-ticket-error'));
  openDialog('resolve-ticket-dialog');
}

export async function submitResolveTicket() {
  if (!state.targetTicket) return;
  const note = document.getElementById('resolve-ticket-note').value.trim();
  if (!note) {
    const err = document.getElementById('resolve-ticket-error');
    err.textContent = 'A resolution note is required to resolve this ticket.';
    show(err);
    return;
  }

  const submitBtn = document.getElementById('resolve-ticket-submit');
  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Resolving...';
    }

    const res = await api('/api/tickets/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket_id: state.targetTicket.ticket_id,
        resolution_note: note,
      }),
    });

    if (!res.ok) {
      let msg = `Ticket resolution failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
        else if (body.error) msg = body.error;
      } catch { /* keep generic */ }
      const err = document.getElementById('resolve-ticket-error');
      if (err) {
        err.textContent = msg;
        show(err);
      }
      return;
    }

    closeDialog('resolve-ticket-dialog');
    if (state.activeChatTicket && state.targetTicket && state.activeChatTicket.ticket_id === state.targetTicket.ticket_id) {
      state.activeChatTicket.status = 'resolved';
      const resolveBtn = document.getElementById('chat-resolve-btn');
      if (resolveBtn) {
        resolveBtn.disabled = true;
        resolveBtn.textContent = 'Resolved';
      }
      const input = document.getElementById('ticket-chat-input');
      if (input) {
        input.disabled = true;
        input.placeholder = 'This ticket has been resolved.';
      }
      const sendBtn = document.getElementById('ticket-chat-send-btn');
      if (sendBtn) sendBtn.disabled = true;
    }
    loadTickets();
    refreshBadgeCounts();
  } catch (e) {
    if (isUnauthorized(e)) return;
    const err = document.getElementById('resolve-ticket-error');
    const msg = `Failed to resolve ticket: ${e.message || 'Network error. Please try again.'}`;
    if (err) {
      err.textContent = msg;
      show(err);
    } else {
      alert(msg);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm Resolve';
    }
  }
}

export function closeTicketChat() {
  if (state.activeChatWs) {
    try { state.activeChatWs.close(); } catch { /* ignore */ }
    state.activeChatWs = null;
  }
  state.activeChatTicket = null;
  hide(document.getElementById('ticket-chat-card'));
}

export async function openTicketChat(ticket) {
  state.activeChatTicket = ticket;
  const card = document.getElementById('ticket-chat-card');
  show(card);

  document.getElementById('chat-ticket-title').textContent = `Ticket #${ticket.ticket_id.slice(-8)} — ${ticket.subject || 'Support'}`;
  document.getElementById('chat-ticket-meta').textContent = `Customer: ${ticket.customer_id} | Status: ${(ticket.status || '').toUpperCase()}`;

  const resolveBtn = document.getElementById('chat-resolve-btn');
  if (ticket.status === 'resolved') {
    resolveBtn.disabled = true;
    resolveBtn.textContent = 'Resolved';
  } else {
    resolveBtn.disabled = false;
    resolveBtn.textContent = 'Resolve Ticket…';
    resolveBtn.onclick = () => openResolveTicketDialog(ticket);
  }

  const kycDocsBtn = document.getElementById('chat-kyc-docs-btn');
  if (kycDocsBtn) {
    kycDocsBtn.onclick = () => openUserDocsDialog({ id: ticket.customer_id, username: ticket.customer_id });
  }

  // Reset file attachment input and preview
  const fileInput = document.getElementById('ticket-chat-file-input');
  if (fileInput) fileInput.value = '';
  const filePreview = document.getElementById('ticket-chat-file-preview');
  if (filePreview) hide(filePreview);

  const chatInput = document.getElementById('ticket-chat-input');
  const sendBtn = document.getElementById('ticket-chat-send-btn');
  if (ticket.status === 'resolved') {
    chatInput.disabled = true;
    chatInput.placeholder = 'This ticket has been resolved.';
    sendBtn.disabled = true;
  } else {
    chatInput.disabled = false;
    chatInput.placeholder = 'Type a message to the customer...';
    sendBtn.disabled = false;
  }

  const messagesContainer = document.getElementById('ticket-chat-messages');
  messagesContainer.textContent = '';
  messagesContainer.appendChild(el('div', 'muted small chat-notice', 'Loading conversation history...'));

  // 1. Fetch channel history
  try {
    const res = await api(`/api/tickets/history?channel=ticket:${encodeURIComponent(ticket.ticket_id)}&limit=50`);
    messagesContainer.textContent = '';
    if (res.ok) {
      const msgs = await res.json();
      if (Array.isArray(msgs) && msgs.length > 0) {
        const sorted = [...msgs].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        for (const m of sorted) appendChatMessage(m);
      } else {
        messagesContainer.appendChild(el('div', 'muted small chat-notice', 'No messages in this ticket yet.'));
      }
    }
  } catch (err) {
    if (isUnauthorized(err)) return;
    messagesContainer.textContent = '';
    messagesContainer.appendChild(el('div', 'error chat-notice', `Failed to load chat history: ${err.message}`));
  }

  // 2. Connect WebSocket
  if (state.activeChatWs) {
    try { state.activeChatWs.close(); } catch { /* ignore */ }
    state.activeChatWs = null;
  }

  const token = sessionStorage.getItem(tokenKey) || '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/api/chat/ws`;

  try {
    const ws = new WebSocket(wsUrl, [WS_AUTH_PROTOCOL, token]);
    state.activeChatWs = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: 'subscribe',
        channel: `ticket:${ticket.ticket_id}`
      }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.channel === `ticket:${ticket.ticket_id}`) {
          if (messagesContainer.querySelector('.chat-notice')) {
            messagesContainer.textContent = '';
          }
          appendChatMessage(msg);
        }
      } catch (e) {
        console.error('Error handling WS message', e);
      }
    };
    ws.onerror = (e) => {
      console.warn('WebSocket error in ticket chat', e);
    };
  } catch (e) {
    console.error('Failed to initialize WebSocket', e);
  }
}

export function appendChatMessage(msg) {
  const container = document.getElementById('ticket-chat-messages');
  if (!container) return;

  if (msg.type === 'system') {
    const sys = document.createElement('div');
    sys.className = 'chat-system-message';
    sys.textContent = msg.content;
    container.appendChild(sys);
    container.scrollTop = container.scrollHeight;
    return;
  }

  const isReviewer = (state.currentReviewer && msg.sender_id === state.currentReviewer.id) ||
    (msg.sender_username && msg.sender_username.includes('Reviewer'));
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isReviewer ? 'reviewer' : 'customer'}`;

  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = msg.sender_username || msg.sender_id || 'User';
  bubble.appendChild(sender);

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = msg.content || '';
  bubble.appendChild(text);

  if (msg.attachment_key || msg.attachment_url) {
    const attachContainer = document.createElement('div');
    attachContainer.className = 'attachment-container';
    const attachType = msg.attachment_type || '';
    if (attachType.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'attachment-img';
      img.alt = msg.attachment_name || 'Attachment image';
      img.title = 'Click to open full image';
      img.addEventListener('click', () => openAttachment(msg.attachment_url));
      (async () => {
        try {
          const urlToken = new URL(msg.attachment_url, location.href).searchParams.get('token');
          if (urlToken) {
            const r = await api(`/api/chat/attachments/view?token=${encodeURIComponent(urlToken)}`);
            if (r.ok) img.src = safeBlobUrl(await r.blob());
          }
        } catch { /* ignore */ }
      })();
      attachContainer.appendChild(img);
    } else {
      const docBtn = document.createElement('button');
      docBtn.type = 'button';
      docBtn.className = 'attachment-doc';
      const sizeStr = msg.attachment_size ? ` (${formatBytes(msg.attachment_size)})` : '';
      docBtn.textContent = `📄 ${msg.attachment_name || 'Document'}${sizeStr}`;
      docBtn.addEventListener('click', () => openAttachment(msg.attachment_url));
      attachContainer.appendChild(docBtn);
    }
    bubble.appendChild(attachContainer);
  }

  if (msg.timestamp) {
    const timeEl = document.createElement('div');
    timeEl.className = 'time';
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.appendChild(timeEl);
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

export async function refreshBadgeCounts() {
  if (!sessionStorage.getItem(tokenKey)) return;
  try {
    const [queueRes, reconRes, subsRes, ticketsRes, payoutsRes] = await Promise.allSettled([
      api('/api/queue').then(r => r.ok ? r.json() : []),
      api('/api/reconciliation/queue?page=1&limit=1').then(r => r.ok ? r.json() : {}),
      api('/api/subscriptions/queue?page=1&limit=1').then(r => r.ok ? r.json() : {}),
      api('/api/tickets?page=1&limit=1').then(r => r.ok ? r.json() : {}),
      api('/api/payouts?status=requested&page=1&limit=1').then(r => r.ok ? r.json() : {}),
    ]);

    if (queueRes.status === 'fulfilled' && Array.isArray(queueRes.value)) {
      const b = document.getElementById('queue-badge');
      if (b) b.textContent = `${queueRes.value.length}`;
    }
    if (reconRes.status === 'fulfilled' && reconRes.value) {
      const b = document.getElementById('reconciliation-badge');
      if (b) b.textContent = `${reconRes.value.total ?? (reconRes.value.disputes?.length || 0)}`;
    }
    if (subsRes.status === 'fulfilled' && subsRes.value) {
      // The badge counts the upgrade requests awaiting verification.
      const b = document.getElementById('subscriptions-badge');
      if (b) b.textContent = `${subsRes.value.total ?? (subsRes.value.queue?.length || 0)}`;
    }
    if (ticketsRes.status === 'fulfilled' && ticketsRes.value) {
      const b = document.getElementById('tickets-badge');
      if (b) b.textContent = `${ticketsRes.value.total ?? (ticketsRes.value.tickets?.length || 0)}`;
    }
    if (payoutsRes.status === 'fulfilled' && payoutsRes.value) {
      const b = document.getElementById('payouts-badge');
      if (b) b.textContent = `${payoutsRes.value.total ?? (payoutsRes.value.payouts?.length || 0)}`;
    }
  } catch {
    // Non-critical background count sync
  }
}

export async function openAttachment(signedUrl) {
  try {
    const token = new URL(signedUrl, location.href).searchParams.get('token');
    if (!token) {
      alert('Attachment token is missing');
      return;
    }
    const res = await api(`/api/chat/attachments/view?token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      alert(`Attachment could not be loaded (HTTP ${res.status})`);
      return;
    }
    const url = safeBlobUrl(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (isUnauthorized(err)) return;
    console.error('Failed to open attachment:', err);
    alert('Failed to open attachment: ' + (err.message || 'network error'));
  }
}

export async function sendTicketAttachment(ticketId, file, content) {
  const formData = new FormData();
  formData.append('file', file);
  if (content) {
    formData.append('content', content);
  }
  // Through api() so a 401 here ends the session like every other call.
  const res = await api(`/api/tickets/attachment?ticket_id=${encodeURIComponent(ticketId)}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status}`);
  }
  return await res.json();
}

export function wire() {
  const refresh = document.getElementById('refresh-tickets-btn');
  if (refresh) refresh.addEventListener('click', loadTickets);

  const form = document.getElementById('tickets-filter-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFilters();
    });
  }
  const reset = document.getElementById('tickets-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('tickets-search-input').value = '';
    document.getElementById('tickets-status-filter').value = '';
    applyFilters();
  });

  const prev = document.getElementById('tickets-prev-btn');
  if (prev) prev.addEventListener('click', () => changePage(state.ticketsState, -1, loadTickets));
  const next = document.getElementById('tickets-next-btn');
  if (next) next.addEventListener('click', () => changePage(state.ticketsState, +1, loadTickets));

  const resolveCancel = document.getElementById('resolve-ticket-cancel');
  if (resolveCancel) resolveCancel.addEventListener('click', () => closeDialog('resolve-ticket-dialog'));
  const resolveSubmit = document.getElementById('resolve-ticket-submit');
  if (resolveSubmit) resolveSubmit.addEventListener('click', submitResolveTicket);

  const closeChat = document.getElementById('chat-close-btn');
  if (closeChat) closeChat.addEventListener('click', closeTicketChat);

  const attachBtn = document.getElementById('ticket-chat-attach-btn');
  const fileInput = document.getElementById('ticket-chat-file-input');
  const filePreview = document.getElementById('ticket-chat-file-preview');
  const fileName = document.getElementById('ticket-chat-file-name');
  const fileRemove = document.getElementById('ticket-chat-file-remove');

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
  }

  if (fileInput && filePreview && fileName) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        const f = fileInput.files[0];
        fileName.textContent = `📎 ${f.name} (${formatBytes(f.size)})`;
        show(filePreview);
      } else {
        hide(filePreview);
      }
    });
  }

  if (fileRemove && fileInput && filePreview) {
    fileRemove.addEventListener('click', () => {
      fileInput.value = '';
      hide(filePreview);
    });
  }

  const ticketChatForm = document.getElementById('ticket-chat-form');
  if (ticketChatForm) {
    ticketChatForm.addEventListener('submit', (e) => onChatSubmit(e));
  }
}

async function onChatSubmit(e) {
  e.preventDefault();
  if (!state.activeChatTicket) return;
  const input = document.getElementById('ticket-chat-input');
  const content = input.value.trim();
  const fileInput = document.getElementById('ticket-chat-file-input');
  const filePreview = document.getElementById('ticket-chat-file-preview');

  if (fileInput && fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const sendBtn = document.getElementById('ticket-chat-send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Uploading…';
    try {
      await sendTicketAttachment(state.activeChatTicket.ticket_id, file, content);
      fileInput.value = '';
      hide(filePreview);
      input.value = '';
    } catch (err) {
      if (err.message !== 'unauthorized') alert('Failed to upload attachment: ' + err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
    return;
  }

  if (!state.activeChatWs || state.activeChatWs.readyState !== WebSocket.OPEN) return;
  if (!content) return;
  state.activeChatWs.send(JSON.stringify({
    action: 'message',
    channel: `ticket:${state.activeChatTicket.ticket_id}`,
    content: content,
  }));
  input.value = '';
}

function applyFilters() {
  const st = state.ticketsState;
  st.search = document.getElementById('tickets-search-input').value.trim();
  st.status = document.getElementById('tickets-status-filter').value;
  st.page = 1;
  loadTickets();
}
