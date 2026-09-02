# AI Context: Reviewer & Operations Console

Persistent, model-agnostic single source of truth for this repository's
state. Update in the same commit as any change (mirrors saas-core's
convention).

## Project Summary

Standalone internal web console for administrative operations on the Quick
Delivery platform (KYB/KYE document review, accounts directory & suspensions,
disputes & reconciliation, subscriptions, and support tickets). Implements the
Support Agent Console deferred by saas-core ADR-0013, scoped per ADR-0021,
ADR-0022, and ADR-0023 (Accepted, scope closed at 5 tabs).

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
- `internal/proxy` — proxy handlers for all 5 operational modules:
  1. KYC Queue & Review (`/api/queue`, `/api/review`, `/api/documents/view`)
  2. Accounts Directory & Suspensions (`/api/accounts`, `/api/accounts/suspend`, `/api/accounts/reactivate`)
  3. Disputes & Escrow Reconciliation (`/api/reconciliation/queue`, `/api/reconciliation/resolve`)
  4. Subscriptions Management (`/api/subscriptions`, `/api/subscriptions/activate`, `/api/subscriptions/revoke`)
  5. Support Tickets (`/api/tickets`, `/api/tickets/resolve`)
  All destructive and override operations enforce local input validation (mandatory reasons, 1–1000 characters) before forwarding to upstream services.
- `cmd/server` — HTTP server with timeouts, CR/LF-sanitized logging, static UI serving, and route registration for all `/api/*` endpoints.
- `web/` — 5-tab vanilla UI (`web/index.html`, `web/app.js`, `web/style.css`) with tab-scoped session auth, search toolbars, status filters, pagination controls, dynamic badge counters, and action dialog modals.
- CI: `.github/workflows/ci.yml` (gofmt, build, vet, test, gosec);
  `.github/workflows/contract-sync.yml` responding to saas-core's `reviewer-api-contract` repository_dispatch.

## Recent Changes

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

