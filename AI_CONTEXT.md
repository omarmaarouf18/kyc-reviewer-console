# AI Context: Reviewer & Operations Console

Persistent, model-agnostic single source of truth for this repository's
state. Update in the same commit as any change (mirrors saas-core's
convention).

## Project Summary

Standalone internal web console for administrative operations on the Quick
Delivery platform (KYB/KYE document review, accounts directory & suspensions,
disputes & reconciliation, subscriptions, support tickets, and payout requests). Implements the
Support Agent Console deferred by saas-core ADR-0013, scoped per ADR-0021,
ADR-0022, and ADR-0023, expanded to 6 tabs per commit `f5b7b6a`.

- **Stack**: Go 1.26 (stdlib-only server) + vanilla HTML/JS/CSS UI.
- **Deployment**: inside the internal network (same compose network as the
  services). Holds `INTERNAL_SERVICE_TOKEN`; fails fast without it.
- **Auth**: pass-through proxy — browser sends `X-Reviewer-Token` only; the
  console injects the internal token server-side. Downstream services (`auth-service`,
  `user-service`, `chat-service`) verify reviewer tokens via `GET /auth/reviewer/verify`.
  Single permission level; no self-service reviewer onboarding.

## What Exists Today

- `internal/config` — env config (`INTERNAL_SERVICE_TOKEN`, `AUTH_SERVICE_URL`,
  `USER_SERVICE_URL`, `CHAT_SERVICE_URL`, `PORT`) with empty-secret fail-fast guard.
- `internal/proxy` — proxy handlers for all 6 operational modules:
  1. KYC Queue & Review (`/api/queue`, `/api/review`, `/api/documents/view`)
  2. Accounts Directory & Suspensions (`/api/accounts`, `/api/accounts/suspend`, `/api/accounts/reactivate`)
  3. Disputes & Escrow Reconciliation (`/api/reconciliation/queue`, `/api/reconciliation/resolve`)
  4. Subscriptions Management (`/api/subscriptions`, `/api/subscriptions/activate`, `/api/subscriptions/revoke`)
  5. Support Tickets (`/api/tickets`, `/api/tickets/resolve`, `/api/tickets/accept`, `/api/tickets/history`, `/api/chat/ws`)
  6. Payout Requests (`/api/payouts`, `/api/payouts/reject`): proxying to `user-service` (`/admin/payouts`, `/admin/payouts/reject`), with mandatory rejection reason (1–1000 chars) and wallet balance restoration.
  All destructive and override operations enforce local input validation (mandatory reasons, 1–1000 characters) before forwarding to upstream services.
- `cmd/server` — HTTP server with timeouts, CR/LF-sanitized logging, static UI serving, and route registration for all `/api/*` endpoints.
- `web/` — 6-tab vanilla UI (`web/index.html`, `web/app.js`, `web/style.css`) with tab-scoped session auth, search toolbars, status filters, pagination controls, dynamic badge counters, and action dialog modals.
- CI: `.github/workflows/ci.yml` (gofmt, build, vet, test, gosec);
  `.github/workflows/contract-sync.yml` responding to saas-core's `reviewer-api-contract` repository_dispatch.

## Recent Changes

### CONSOLE-SEC: stored-XSS fix and console hardening

- **XSS rule (item 1)**: API data (names, emails, ids, notes, reasons, ticket
  messages, file names, enums) reaches the DOM only through `textContent`,
  via the `el()` / `badge()` / `detailRow()` helpers in `web/app.js`.
  `innerHTML` remains only for static markup with no interpolation. Badge
  classes come from fixed maps, never from API values. Documents and chat
  attachments open from blob: URLs re-typed by `safeBlobUrl()`: only
  images/PDF render inline, anything else (e.g. `text/html`) becomes a
  download, because a blob: page would run in the console origin.
- **Web tests run the real app**: `web/testdom.js` is a dependency-free DOM
  that parses `web/index.html` and runs `web/app.js` in a `vm` context;
  `web/xss_test.js` renders every table/dialog with
  `<img src=x onerror=alert(1)>` payloads and asserts no element or `on*`
  attribute was created. Run: `node --test web/*_test.js`.
- **Security headers (item 2)**: `cmd/server/routes.go` (`newHandler`)
  wraps every response with a strict CSP (`default-src 'self'; script-src
  'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'`
  plus `wss://<host>` — and `ws://<host>` on plain HTTP — for the chat
  socket; `object-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera, microphone,
  geolocation off), `X-Frame-Options: DENY`, and `Cache-Control: no-store`
  on `/api/*`. The Host header is validated before it is echoed into the
  CSP. No inline script, handler or style attribute may be added to
  `web/` (CSP blocks them). Static serving is an allow-list (`/`,
  `/index.html`, `/app.js`, `/style.css`) so test files under `web/` are
  never served. Tests: `cmd/server/routes_test.go`.
- **Session hygiene (item 3)**: idle sign-out after `IDLE_TIMEOUT_MS`
  (30 min, `web/app.js`) without pointer/keyboard activity, checked every
  30 s and on page load (last activity is kept in sessionStorage so a
  reload does not extend a stale session). Every 401 (all calls go through
  `api()`, including attachment upload) and "Sign out" run the same
  `logout()`: `sessionStorage.clear()`, chat socket closed, every
  in-memory target/filter reset, rendered tables/dialogs/chat/inputs
  emptied. The reviewer token is never in a URL: the chat socket offers
  it as the second WebSocket subprotocol (`kyc-console-auth, <token>`);
  `ChatWebSocket` takes it from there, drops any client query string and
  builds the upstream `?token=` server-side (chat-service only accepts
  the query — saas-core follow-up), and echoes `kyc-console-auth` on 101.
  Deprecated fallback: a client offering no subprotocol may still send
  `?token=` (saas-core `tests/e2e` `ConnectConsoleWS` does); remove it once
  that suite dials with `Subprotocols: ["kyc-console-auth", token]`.
  Upstream error logs no longer print `*url.Error` text or query strings
  (`upstreamErrText`, `stripQuery`). Tests: `web/session_test.js`,
  `internal/proxy/websocket_test.go`.
- **Proxy hardening (item 4)**: every JSON POST body is capped at 64 KB
  (`maxJSONBody`, `decodeJSON` → 413), ticket attachments at 10 MB +
  framing (`maxUploadBody` → 413 instead of the old silent truncation);
  GET bodies are no longer forwarded. Routes are one table
  (`apiRoutes` in `cmd/server/routes.go`) with a per-route method
  allow-list (405 + `Allow`). The unused `/admin/payouts` and
  `/admin/payouts/reject` console aliases are gone (the UI calls
  `/api/payouts*`; user-service's upstream paths are unchanged). Upstream
  error responses (>= 400) are reduced to the JSON error contract
  (`error`, `message`, `code`, `request_id`); any other body becomes
  `{"error":"upstream error"}` with the same status. Tests:
  `internal/proxy/hardening_test.go`, `cmd/server/routes_test.go`.
- **UI fixes (item 5)**: the disputes table/dialog show only fields the
  user-service queue item (`AdminReconciliationJobItem`) actually carries
  — no pickup/dropoff address or category exist, so the "Job & Route" /
  "Category" columns became "Job" / "Service"; dialog rows with no value
  are omitted (the courier row appears only when `employee_id`, which is
  `omitempty`, is present). Payout amounts are shown in EGP (were "$"),
  and payout status badges/filter use saas-core's `requested`,
  `approved`, `paid`, `rejected` (the UI had a non-existent `processed`).
  CI now runs the web tests (`node --test web/*_test.js`, Node 24).
  Tests: `web/ui_test.js`.

### KYC User Documents Admin Access & Support Ticket File Attachments

- **Feature Summary**:
  - **Part A (KYC Document Admin Access)**: Added proxy route `GET /api/documents/user?user_id=...&reason=...` relaying to `auth-service` `GET /auth/reviewer/user-documents`. Enforces reviewer authentication, mandatory audit reason (1–1000 characters), and surfaces out-of-band KYC/KYE identity documents for any user directly in the Accounts Directory and Ticket Chat header with refreshable signed URLs.
  - **Part B (Support Ticket Chat File Upload)**: Added proxy routes `POST /api/tickets/attachment` (relaying multipart/form-data up to 10MB to `chat-service` `POST /chat/tickets/{id}/attachment`) and `GET /api/chat/attachments/view?token=...` (relaying decrypted attachment streaming). Updated Web UI (`web/index.html`, `web/app.js`, `web/style.css`) with file attachment input, attachment badge/preview, clickable image thumbnails, and PDF document cards.
- **Verification Evidence**:
  - Unit tests in `internal/proxy/proxy_test.go`: `TestUserDocuments_ValidationsAndForwarding`, `TestTicketAttachment_ValidationsAndForwarding`, `TestAttachmentView_ValidationsAndForwarding`.
  - Node.js tests in `web/app_test.js`: formatBytes formatting, retrieveUserDocs mandatory reason validation, and sendTicketAttachment multipart FormData with reviewer token.
  - All tests passing 100% (`go test -v ./...` and `node --test web/app_test.js`).

### Payout Requests & Rejection Flow (`f5b7b6a`)

- **Feature Summary**: Added Tab 6 for reviewing pending courier/owner payout requests (`/api/payouts`, `/admin/payouts`) and rejecting requests with a mandatory reason (1–1000 characters) via `POST /api/payouts/reject`.
- **Backend Proxying**: Console proxies calls to `user-service` (`GET /admin/payouts` and `POST /admin/payouts/reject`), attaching `X-Internal-Token` and forwarding reviewer credentials. Rejections execute an atomic Compare-and-Swap (CAS) state transition from `pending` to `rejected`, logging audit events and automatically restoring the user's withdrawable wallet balance.
- **Verification Evidence**:
  - Full unit test coverage in `internal/proxy/proxy_test.go` (`TestPayouts_ForwardedToUserService`, `TestRejectPayout_ForwardedToUserService`, `TestRejectPayout_ValidationErrors`).
  - Web UI integration verified with 6-tab navigation, modal rejection dialog, and dynamic badge counts.

### Ticket Resolve & Dialog Unhandled Rejection Prevention and Transient Error Handling

- **Unhandled Promise Rejection & Reviewer Kickout**:
  - *Root Cause*: `submitResolveTicket()` called `await api('/api/tickets/resolve', ...)` without a `try...catch` block. When `api()` encountered an HTTP 401 (caused by upstream transient auth failure or token expiry), it cleared session and threw `new Error('unauthorized')`. The unhandled rejection manifested as a browser crash while the reviewer was kicked out to the login view. Additionally, other action dialogs (`openDocument`, `submitReview`, `submitSuspend`, `submitReactivate`, `submitResolveDispute`, `submitActivateSub`, `submitRevokeSub`) lacked `try...catch` guards around `api()` calls.
  - *Fix*: Wrapped `submitResolveTicket()` and all sibling dialog submit handlers in `try...catch...finally` blocks. Documented session policy in `api()`: only genuine 401s invoke `logout()`, while transient 503/502/429 codes return to callers for in-app retryable messaging. Added button loading state (`Resolving...` -> `Confirm Resolve`) and error rendering in `#resolve-ticket-error`.
- **Verification Evidence**:
  - Node.js test suite (`web/app_test.js`) verifying 401 logout, 503 retryable non-logout, and `submitResolveTicket` crash prevention passed 100% (`node --test web/app_test.js`).
  - Go proxy tests in `internal/proxy/proxy_test.go` (`Upstream 503 Service Unavailable Relayed As 503`, `Upstream 401 Unauthorized Relayed As 401`) passed 100% (`go test -count=1 ./...`).

### CSS Hidden-Specificity Fix & chat-service Port Alignment (`a1c12c7`)

- **CSS Specificity Bug**:
  - *Root Cause*: `web/style.css` defined `#login-view { display: grid; ... }` with ID-selector specificity, overriding the User Agent stylesheet's `[hidden] { display: none; }` default. When `app.js` executed `hide(document.getElementById('login-view'))`, the element retained `display: grid`, causing the login card to render over the dashboard.
  - *Fix*: Added global `[hidden] { display: none !important; }` rule near the top of `web/style.css`.
- **chat-service Port Misconfiguration**:
  - *Root Cause*: `internal/config/config.go` and `internal/proxy/proxy.go` defaulted `ChatServiceURL` to `https://chat-service:3005`, but `chat-service` listens on port `3001`. This caused `GET /api/tickets` to fail with HTTP 502 (`dial tcp 172.20.0.8:3005: connect: connection refused`).
  - *Fix*: Corrected fallback default to `https://chat-service:3001` across config loaders, proxy constructors, `README.md`, and unit tests.
- **Dynamic Badge Counters & Session Bootstrap**:
  - Added `refreshBadgeCounts()` in `web/app.js` to query `/api/queue`, `/api/reconciliation/queue`, `/api/subscriptions`, and `/api/tickets` in parallel, updating all tab pill counters immediately upon sign-in.
  - Added session bootstrap check on page reload for authenticated reviewer tokens.
- **Verification Evidence**:
  - All Go unit tests passing (`go test -v ./...`).
  - Headless Chromium CDP browser automation test proved pre-login `#login-view: grid` / `#app-view: none` and post-login `#login-view: none` / `#app-view: block` computed styles (0 overlap).
  - All 5 routes (`/api/queue`, `/api/accounts`, `/api/reconciliation/queue`, `/api/subscriptions`, `/api/tickets`) return `200 OK` on production stack (`quickdelivery-vm`).

## Standing Rules

- Every code change updates this file in the same commit.
- The internal service token must never be logged, embedded in the UI bundle, or sent anywhere except downstream internal microservices.
- Reviewer tokens are never persisted server-side by this console.
- Any change to downstream admin endpoint shapes must come with matching proxy updates here and clean contract tests.

