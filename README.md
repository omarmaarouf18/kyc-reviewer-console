# Reviewer & Operations Console

Standalone internal web console for administrative operations on the Quick Delivery platform: KYB/KYE document review, accounts directory & suspensions, escrow dispute reconciliation, subscription management, and support ticket resolution. Implements the deferred Support Agent Console from saas-core [ADR-0013], scoped per saas-core [ADR-0021], [ADR-0022], and [ADR-0023].

[ADR-0013]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0013-support-agent-console-as-separate-client-application.md
[ADR-0021]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0021-kyc-kyb-kye-reviewer-console.md
[ADR-0022]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0022-account-suspension-and-reviewer-directory.md
[ADR-0023]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0023-modular-ops-console-expansion.md

## Why this shape (summary)

The saas-core `api-gateway` strips `X-Internal-Token` from every inbound client request. All backend administrative endpoints (`auth-service`, `user-service`, `chat-service`) require BOTH `X-Internal-Token` (internal network context) and `X-Reviewer-Token` (individual reviewer credential).

No external consumer application can reach administrative endpoints directly — by design. This console is a thin Go proxy service deployed **inside** the internal private network (`saas-net`): it injects the internal service token server-side, serves a vanilla browser UI, and proxies administrative requests to internal services without exposing secrets. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full end-to-end flow.

## Auth & Security Invariants

- **Two-Token Contract**: Reviewers authenticate with their `X-Reviewer-Token` (onboarded server-side via saas-core's `onboard-reviewer` CLI; hashed at rest in `auth_db.reviewers`). The internal service token never reaches the browser.
- **No Self-Service Admin Accounts**: Reviewer accounts are created exclusively via manual server-side CLI operations (`cmd/onboard-reviewer`). There is no public registration or self-service signup.
- **Single Permission Level**: All authenticated reviewers have uniform access across all 5 console tabs (no complex nested RBAC or sub-role splits).
- **Tab-Scoped Session**: The reviewer token is held in browser `sessionStorage` (closing the tab signs out).
- **Mandatory Reasons**: All destructive and override mutations (KYC rejections, account suspensions, dispute overrides, subscription revocations, ticket resolutions) strictly enforce mandatory reasons (1–1000 characters) both in the UI and server-side.

## Setup

### Local development

```bash
go 1.26+

export INTERNAL_SERVICE_TOKEN=<internal token>   # required, fail-fast if empty
export AUTH_SERVICE_URL=http://localhost:3002    # default: https://auth-service:3002
export USER_SERVICE_URL=http://localhost:3003    # default: https://user-service:3003
export CHAT_SERVICE_URL=http://localhost:3001    # default: https://chat-service:3001
export PORT=8090                                 # default

go run ./cmd/server
# open http://localhost:8090
```

Optional mTLS to downstream services (matches saas-core services):
set `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TLS_CA_PATH`.

### Docker

```bash
docker build -t kyc-reviewer-console .
docker run --rm -p 8090:8090 \
  -e INTERNAL_SERVICE_TOKEN=... \
  -e AUTH_SERVICE_URL=https://auth-service:3002 \
  -e USER_SERVICE_URL=https://user-service:3003 \
  -e CHAT_SERVICE_URL=https://chat-service:3001 \
  kyc-reviewer-console
```

Deploy the container on the same compose network (`saas-net`) so downstream services resolve internally.

## Features (5 Core Modules — Scope Closed per ADR-0023)

1. **Pending Submissions (KYC/KYB/KYE)** (`/api/queue`, `/api/review`, `/api/documents/view`):
   - Review pending identity documents for business owners (KYB) and couriers (KYE).
   - Approvals and rejections with mandatory reason (1–1000 chars) and automated customer notification.
   - Secure byte-streaming document relay without exposing storage credentials.
2. **Accounts Directory & Suspensions** (`/api/accounts`, `/api/accounts/suspend`, `/api/accounts/reactivate`):
   - Universal account directory with search by username, email, or user ID.
   - Role and status filtering with pagination.
   - Account suspension with mandatory reason (1–1000 chars), JWT session invalidation, and notification dispatch.
3. **Disputes & Reconciliation** (`/api/reconciliation/queue`, `/api/reconciliation/resolve`):
   - Review disputed delivery jobs (`escrow_reconciliation_required`) flagged by GPS under-distance checks.
   - Inspect tracked vs booked route discrepancy and locked escrow amounts.
   - Resolve disputes via reviewer override (`release_to_employee` or `refund_to_customer`) with mandatory reason.
4. **Subscriptions Management** (`/api/subscriptions`, `/api/subscriptions/activate`, `/api/subscriptions/revoke`):
   - Monitor tenant subscriptions across all tiers (`pending_payment`, `free`, `paid`, `cancelled`).
   - Manual plan activation with configurable duration (e.g. 30, 60, 90, 365 days).
   - Plan revocation with mandatory reason (1–1000 chars) and audit logging.
5. **Support Tickets Inbox & Resolution** (`/api/tickets`, `/api/tickets/resolve`):
   - Universal support ticket inbox across all tenants and customers.
   - Status filtering (`pending`, `assigned`, `resolved`) and search.
   - Resolve tickets with mandatory resolution note (1–1000 chars), releasing assigned agents.

## CI/CD

- `.github/workflows/ci.yml` — gofmt, build, vet, unit tests, and gosec on every push/PR.
- `.github/workflows/contract-sync.yml` — runs contract/integration tests when saas-core fires a `reviewer-api-contract` repository_dispatch on pushes touching reviewer endpoint surfaces.

## Repository Relationship to saas-core

This repo holds original code; it is NOT a subtree mirror of the monorepo. The connection is:

1. Runtime: this service proxies to `auth-service`, `user-service`, and `chat-service` over the internal network.
2. CI: saas-core → `repository_dispatch` → contract test run here.
3. Semantics: ADR-0013 / ADR-0021 boundary enforcement — no reviewer capability may ever be reintroduced into the consumer mobile app binary; all administrative interfaces live here.

