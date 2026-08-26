# KYC/KYB/KYE Reviewer Console

Standalone internal web console for reviewing KYB (owner business) and KYE
(employee identity) verification submissions. Implements the deferred Support
Agent Console from saas-core [ADR-0013], scoped to identity review per
saas-core [ADR-0021]. Support-ticket resolution remains out of scope.

[ADR-0013]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0013-support-agent-console-as-separate-client-application.md
[ADR-0021]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0021-kyc-kyb-kye-reviewer-console.md

## Why this shape (summary)

The saas-core api-gateway strips `X-Internal-Token` from every inbound client
request, and auth-service reviewer endpoints require BOTH `X-Internal-Token`
(internal network context) and `X-Reviewer-Token` (individual credential).
No external application can therefore reach reviewer endpoints directly — by
design. This console is a thin Go service deployed **inside** the internal
network: it injects the internal token server-side, serves a minimal browser
UI, and makes no authorization decisions of its own. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full end-to-end flow.

## Auth model

- Reviewers authenticate with their existing `X-Reviewer-Token` (the same
  hashed-token records auth-service already uses; onboarded via saas-core's
  `onboard-reviewer` CLI). No user JWTs, no new account system.
- The token lives in browser `sessionStorage` (tab-scoped; closing the tab
  signs out). The internal service token never reaches any browser.
- Every proxied call carries both tokens; auth-service remains the single
  authentication authority.

## Setup

### Local development

```bash
go 1.26+

export INTERNAL_SERVICE_TOKEN=<internal token>   # required, fail-fast if empty
export AUTH_SERVICE_URL=http://localhost:3002    # default: https://auth-service:3002
export PORT=8090                                 # default

go run ./cmd/server
# open http://localhost:8090
```

Optional mTLS to auth-service (matches other saas-core services):
set `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TLS_CA_PATH`.

### Docker

```bash
docker build -t kyc-reviewer-console .
docker run --rm -p 8090:8090 \
  -e INTERNAL_SERVICE_TOKEN=... \
  -e AUTH_SERVICE_URL=https://auth-service:3002 \
  kyc-reviewer-console
```

Deploy the container on the same compose network as the services so
`auth-service` resolves internally.

## Features

- **Login** — reviewer token probe against the queue endpoint.
- **Queue** — pending submissions (`GET /auth/kyb-kye/pending`) with username,
  role, status.
- **Review** — approve / reject (`POST /auth/kyb-kye/review`). The reason
  field is required-and-validated in the UI when rejecting, mirroring the
  mandatory server-side rule (400 without a reason) added in ADR-0021;
  bounded at 1000 characters.
- **Documents** — signed view URLs are consumed server-side by the proxy;
  bytes stream through `/api/documents/view` so the browser can render them.

## CI/CD

- `.github/workflows/ci.yml` — gofmt, build, vet, tests, gosec on every
  push/PR (same gate philosophy as saas-core).
- `.github/workflows/contract-sync.yml` — runs contract/integration tests when
  saas-core fires a `reviewer-api-contract` repository_dispatch (triggered by
  pushes touching `services/auth-service/**` or the notification send path),
  so API-shape changes surface immediately.

## Repository relationship to saas-core

This repo holds original code; it is NOT a subtree mirror of the monorepo
(unlike `quick-delivery-mobile`). The connection is:

1. Runtime: this service calls auth-service endpoints over the internal
   network (documented in saas-core's `docs/APPLICATION_MAP.md`).
2. CI: saas-core → `repository_dispatch` → contract test run here (above).
3. Semantics: ADR-0013 boundary enforcement — no reviewer capability may ever
   be reintroduced into the consumer app binary; changes to review workflows
   belong here or in saas-core backend only.
