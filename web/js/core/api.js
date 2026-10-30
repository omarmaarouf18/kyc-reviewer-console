// API client: every console call goes through api().
//
// The reviewer token is held per-tab (sessionStorage) and sent as
// X-Reviewer-Token; the internal service token is injected server-side and
// never visible here (ADR-0021 / ADR-0022).
//
// 401 (invalid/expired token) ends the session; every other failure —
// 503 service unavailable, 502 bad gateway, 429 rate limit — is returned to
// the caller so it can display a retryable message without clearing session
// state. readError() maps response bodies and transport failures to messages.

export const tokenKey = 'reviewer_token';

export const WS_AUTH_PROTOCOL = 'kyc-console-auth';

export function authHeaders() {
  return { 'X-Reviewer-Token': sessionStorage.getItem(tokenKey) || '' };
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...options.headers, ...authHeaders() },
  });
  // Only genuine 401s force logout.
  if (res.status === 401) {
    // Imported lazily to avoid the api <-> session cycle at module init.
    const { logout } = await import('./session.js');
    logout('Session expired or invalid token.');
    throw new ApiError('unauthorized', res);
  }
  return res;
}

export class ApiError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'ApiError';
    this.response = response;
  }
}

export function isUnauthorized(err) {
  return err instanceof Error && err.message === 'unauthorized';
}

// readError turns a failed Response plus a transport error into a display
// message, honouring the services' {"error", "message", "code"} contract and
// mapping the documented error codes to friendly text.
export async function readError(res, fallbackPrefix) {
  let generic = `${fallbackPrefix} (HTTP ${res.status})`;
  try {
    const body = await res.clone().json();
    const raw = body.message || body.error || generic;
    return mapErrorCode(raw, body.code);
  } catch {
    return generic;
  }
}

const ERROR_CODE_TEXT = {
  invalid_reason: 'Reason is required (1-1000 characters).',
  invalid_title: 'Both an English and an Arabic title (max 120 characters) are required.',
  invalid_body: 'Both an English and an Arabic body (max 1000 characters) are required.',
  invalid_deep_link: 'This deep link is not an allowed in-app route.',
  invalid_audience: 'The audience selection is invalid.',
  confirmation_required: 'Confirm the typed audience size, then send again.',
  rate_limit_exceeded: 'Rate limit exceeded (5 sends per hour). Try again later.',
};

function mapErrorCode(message, code) {
  if (code && ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];
  return message;
}
