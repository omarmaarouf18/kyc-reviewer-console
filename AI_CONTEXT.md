# AI Context: KYC/KYB/KYE Reviewer Console

Persistent, model-agnostic single source of truth for this repository's
state. Update in the same commit as any change (mirrors saas-core's
convention).

## Project Summary

Standalone internal web console for KYB/KYE identity review on the Quick
Delivery platform. Implements the Support Agent Console deferred by saas-core
ADR-0013, scoped to KYC/KYB/KYE review by saas-core ADR-0021 (Accepted,
2026-08-26). Ticket resolution remains out of scope.

- **Stack**: Go 1.26 (stdlib-only server) + vanilla HTML/JS/CSS UI.
- **Deployment**: inside the internal network (same compose network as the
  services). Holds `INTERNAL_SERVICE_TOKEN`; fails fast without it.
- **Auth**: pass-through proxy — browser sends `X-Reviewer-Token` only; the
  console injects the internal token server-side. auth-service remains the
  sole authentication authority. No sessions, no user JWTs.

## What Exists Today

- `internal/config` — env config with empty-secret fail-fast guard (Q23
  discipline), tested.
- `internal/proxy` — queue/review/document-view/accounts/suspend/reactivate proxies
  with the two-token contract, local payload validation mirroring auth-service's
  mandatory rejection and suspension reasons + 1000-char bounds, byte-streaming
  document relay; regression-tested via httptest stubs asserting token forwarding
  and that invalid payloads never reach upstream (ADR-0021 / ADR-0022).
- `cmd/server` — HTTP server (timeouts, CR/LF-sanitized request logging,
  optional mTLS client for auth-service), static UI serving with `/api/queue`,
  `/api/review`, `/api/documents/view`, `/api/accounts`, `/api/accounts/suspend`,
  and `/api/accounts/reactivate`.
- `web/` — login (sessionStorage tab-scoped reviewer token), tabbed interface
  switching between Pending Queue and Accounts Directory, search and filter
  controls, pagination, status badges, review modal, and suspend/reactivate modals.
- CI: `.github/workflows/ci.yml` (gofmt/build/vet/test/gosec);
  `.github/workflows/contract-sync.yml` responding to saas-core's
  `reviewer-api-contract` repository_dispatch.

## Standing Rules

- Every code change updates this file in the same commit.
- The internal service token must never be logged, embedded in the UI bundle,
  or sent anywhere except auth-service over the internal network.
- Reviewer tokens are never persisted server-side by this console.
- Any change to the auth-service review endpoints' request/response shape must
  come with matching updates here AND a re-run of contract tests (saas-core's
  trigger workflow fires automatically on pushes touching those paths).
