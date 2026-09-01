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

## Standing Rules

- Every code change updates this file in the same commit.
- The internal service token must never be logged, embedded in the UI bundle, or sent anywhere except downstream internal microservices.
- Reviewer tokens are never persisted server-side by this console.
- Any change to downstream admin endpoint shapes must come with matching proxy updates here and clean contract tests.

