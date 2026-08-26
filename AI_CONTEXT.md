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
- `internal/proxy` — queue/review/document-view proxies with the two-token
  contract, local payload validation mirroring auth-service's mandatory
  rejection reason + 1000-char bound, byte-streaming document relay;
  regression-tested via httptest stubs asserting token forwarding and that
  invalid payloads never reach upstream.
- `cmd/server` — HTTP server (timeouts, CR/LF-sanitized request logging,
  optional mTLS client for auth-service), static UI serving.
- `web/` — login (sessionStorage tab-scoped reviewer token), pending queue,
  review dialog with reason required when rejecting, document viewer opening
  proxied blobs.
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
