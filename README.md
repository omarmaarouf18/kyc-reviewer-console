# Reviewer & Operations Console

Standalone internal web console for administrative operations on the Quick Delivery platform: KYB/KYE document review, accounts directory & suspensions, escrow dispute reconciliation, subscription management, support ticket resolution, and payout requests. Implements the deferred Support Agent Console from saas-core [ADR-0013], scoped per saas-core [ADR-0021], [ADR-0022], and [ADR-0023].

[ADR-0013]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0013-support-agent-console-as-separate-client-application.md
[ADR-0021]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0021-kyc-kyb-kye-reviewer-console.md
[ADR-0022]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0022-account-suspension-and-reviewer-directory.md
[ADR-0023]: https://github.com/omarmaarouf18/saas-core/blob/main/docs/adr/0023-modular-ops-console-expansion.md

## Why this shape (summary)

The saas-core `api-gateway` strips `X-Internal-Token` from every inbound client request. All backend administrative endpoints (`auth-service`, `user-service`, `chat-service`, `notification-service`, `api-gateway`) require BOTH `X-Internal-Token` (internal network context) and `X-Reviewer-Token` (individual reviewer credential).

No external consumer application can reach administrative endpoints directly — by design. This console is a thin Go proxy service deployed **inside** the internal private network (`saas-net`): it injects the internal service token server-side, serves a vanilla browser UI, and proxies administrative requests to internal services without exposing secrets. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full end-to-end flow.

## Auth & Security Invariants

- **Two-Token Contract**: Reviewers authenticate with their `X-Reviewer-Token` (onboarded server-side via saas-core's `onboard-reviewer` CLI; hashed at rest in `auth_db.reviewers`). The internal service token never reaches the browser.
- **No Self-Service Admin Accounts**: Reviewer accounts are created exclusively via manual server-side CLI operations (`cmd/onboard-reviewer`). There is no public registration or self-service signup.
- **Single Permission Level**: All authenticated reviewers have uniform access across all console pages (Overview + 6 modules; no complex nested RBAC or sub-role splits).
- **Tab-Scoped Session**: The reviewer token is held in browser `sessionStorage` (closing the tab signs out), with a 30-minute idle sign-out (see [Security](#security)).
- **Mandatory Reasons**: All destructive and override mutations (KYC rejections, account suspensions, dispute overrides, subscription revocations, ticket resolutions, payout rejections, app version policy updates) strictly enforce mandatory reasons (1–1000 characters) both in the UI and server-side.

## Security

Browser-side and proxy-side hardening (CONSOLE-SEC). Keep these rules when changing the UI or the proxy.

- **XSS rule — never interpolate API data into HTML.** Anything that comes from an API response (names, emails, ids, addresses, notes, reasons, ticket messages, file names, status enums) reaches the DOM only through `textContent` — in `web/js/` use `el(tag, className, text)`, `badge()` and `detailRow()` (core/dom.js). `innerHTML` is allowed only for static markup with no `${...}`. CSS classes are picked from fixed maps, never built from API values. `web/xss_test.js` renders every table and dialog with `<img src=x onerror=alert(1)>` payloads and fails if any element or `on*` attribute is created.
- **Content-Security-Policy** on every response (`cmd/server/routes.go`):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://<host>; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  (`ws://<host>` is added on plain HTTP for local dev). No inline `<script>`, `on*=` handler or `style="..."` attribute is possible — put code in the `web/js/` ES modules and styles in `style.css`.
- **Other headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Frame-Options: DENY`, and `Cache-Control: no-store` on `/api/*`. Only `/`, `/index.html`, `/style.css`, an explicit allow-list of `web/js/` ES modules and the four bundled `web/fonts/*.woff2` files (IBM Plex Sans Arabic, OFL license in `web/fonts/`) are served from `web/`; CSP pins `font-src 'self'`.
- **Documents & attachments** open from `blob:` URLs, which run in the console origin, so `safeBlobUrl()` renders only JPEG/PNG/GIF/WebP/PDF inline; any other type is handed over as a download.
- **Session**: idle sign-out after 30 minutes without pointer/keyboard activity (`IDLE_TIMEOUT_MS` in `web/js/core/session.js`). A 401 from any call, the idle timeout and "Sign out" all clear `sessionStorage`, close the chat socket and remove rendered reviewer data. The reviewer token is never put in a URL or logged: the chat WebSocket offers it as a subprotocol (`kyc-console-auth, <token>`) and the proxy adds the `?token=` that chat-service requires server-side.
- **Proxy limits**: JSON POST bodies ≤ 64 KB, ticket attachments ≤ 10 MB (413 above); each route accepts only its listed methods (405 + `Allow`); upstream error bodies are reduced to the `{"error","message","code","request_id"}` contract, anything else becomes `{"error":"upstream error"}`.

Tests: `go test ./... -count=1` and `node --test web/*_test.js` (no npm install needed).

## Setup

### Local development

```bash
go 1.26+

export INTERNAL_SERVICE_TOKEN=<internal token>   # required, fail-fast if empty
export AUTH_SERVICE_URL=http://localhost:3002    # default: https://auth-service:3002
export USER_SERVICE_URL=http://localhost:3003    # default: https://user-service:3003
export CHAT_SERVICE_URL=http://localhost:3001    # default: https://chat-service:3001
export NOTIFICATION_SERVICE_URL=http://localhost:3004  # default: https://notification-service:3004
export GATEWAY_INTERNAL_URL=http://localhost:8080      # default: https://api-gateway:8080
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
  -e NOTIFICATION_SERVICE_URL=https://notification-service:3004 \
  -e GATEWAY_INTERNAL_URL=https://api-gateway:8080 \
  kyc-reviewer-console
```

Deploy the container on the same compose network (`saas-net`) so downstream services resolve internally.

## Features (6 Core Modules — Expanded per commit f5b7b6a)

> CONSOLE-V2 rebuild: the pages share one UI kit (table controller with
> pagination, dialog helper, toasts), one AR/EN dictionary and one
> light/dark theme. A shell-level banner warns when jobs are stuck in escrow
> reconciliation (COD) and jumps to the jobs page filtered on that status.

0. **Overview** (`/api/overview`): operational counters (pending KYB/KYE reviews, subscriptions pending payment, open/assigned tickets, GPS disputes, stuck COD jobs, today's jobs by status, new/suspended accounts). Figures from a backend that fails inside user-service arrive as `unavailable` and are shown as such, never as 0.

1. **Pending Submissions (KYC/KYB/KYE)** (`/api/queue`, `/api/review`, `/api/documents/view`):
   - Review pending identity documents for business owners (KYB) and couriers (KYE).
   - List + review side panel: pick a row to see the details, its document links and the approve/reject decision.
   - Keyboard shortcuts: `↑`/`↓` (or `j`/`k`) move the selection, `Enter` opens the panel, `a` approves, `r` rejects, `Esc` closes, `?` shows the hint.
   - Approvals and rejections with mandatory reason (1–1000 chars) and automated customer notification.
   - Secure byte-streaming document relay without exposing storage credentials.
2. **Accounts Directory & Suspensions** (`/api/accounts`, `/api/accounts/suspend`, `/api/accounts/reactivate`):
   - Universal account directory with search by username, email, or user ID.
   - Role and status filtering with pagination.
   - Clicking a row opens the account drawer (verification status, standing, suspension reason) with the KYC-documents and suspend/reactivate actions.
   - Account suspension with mandatory reason (1–1000 chars), JWT session invalidation, and notification dispatch.
3. **Jobs Lookup & Support Actions** (`/api/jobs`, `/api/jobs/{id}`, `/api/jobs/{id}/cancel`, `/api/jobs/{id}/complete-stuck-cod`):
   - Search jobs across tenants by job ID, customer, status and date range.
   - Full job model on demand (status history, addresses, escrow, reconciliation flags and the unmasked phones the audited `job.view` response carries).
   - Cancel a job with a mandatory reason (1–1000 chars) and repair a stuck COD job through the same path as the FIX-COD-RECON sweep.
4. **Disputes & Reconciliation** (`/api/reconciliation/queue`, `/api/reconciliation/resolve`):
   - Review disputed delivery jobs (`escrow_reconciliation_required`) flagged by GPS under-distance checks.
   - Inspect tracked vs booked route discrepancy and locked escrow amounts.
   - Resolve disputes via reviewer override (`release_to_employee` or `refund_to_customer`) with mandatory reason.
5. **Marketplace Services Moderation** (`/api/services`, `/api/services/{id}/hide`, `/api/services/{id}/unhide`, `/api/services/{id}/photo/remove`):
   - List business services with tenant/name/photo/visibility filters.
   - Hide or unhide a listing with a mandatory reason (the owner is notified).
   - Remove an inappropriate or infringing service photo (object storage deletion) with a mandatory reason.
6. **Subscriptions Management** (`/api/subscriptions/queue`, `/api/subscriptions`, `/api/subscriptions/activate`, `/api/subscriptions/revoke`):
   - Queue-first: the page opens on the pending upgrade requests awaiting manual payment verification (oldest first) — tenant, requested plan, request date and the owner contact (name, username, email, phone).
   - Manual plan activation with configurable duration (e.g. 30, 60, 90, 365 days) from the queue row (`{tenant_id, subscription_id, duration_days}`).
   - A second view lists every subscription across all tiers (`pending_payment`, `free`, `paid`, `cancelled`) with its expiry and audit trail.
   - Plan revocation with mandatory reason (1–1000 chars) and audit logging.
   - The sidebar badge counts the upgrade queue, not the whole subscription table.
7. **Support Tickets Inbox & Resolution** (`/api/tickets`, `/api/tickets/resolve`):
   - Universal support ticket inbox across all tenants and customers.
   - Status filtering (`pending`, `assigned`, `resolved`) and search.
   - Resolve tickets with mandatory resolution note (1–1000 chars), releasing assigned agents.
8. **Payout Requests** (`/api/payouts`, `/api/payouts/reject`):
   - Review pending courier and business owner payout requests.
   - Status filtering (`pending`, `completed`, `rejected`) and pagination.
   - Payout rejection with mandatory reason (1–1000 chars), proxying to `user-service` (`POST /admin/payouts/reject`) to perform atomic Compare-and-Swap (CAS) state transition from `pending` to `rejected` and automatically restore the user's withdrawable wallet balance (authorized via commit `f5b7b6a`).
9. **Audit Log Viewer** (`/api/audit` → auth-service `GET /admin/audit`):
   - One merged, newest-first view of every service's `admin_audit` records (auth, user, chat, notification, gateway).
   - Filters by reviewer (`actor_id`), action, target id and date range; every field is rendered as text.
   - The per-source status strip shows which source answered (`ok`) and which is `unavailable`, so a partial log is never mistaken for a complete one.
10. **App Version Policy** (`/api/version` → api-gateway `GET|PUT /admin/version`):
   - Shows the latest release, the minimum supported version, the enforcement flag, the store download URL and the policy revision.
   - Update the policy with a mandatory reason (1–1000 chars); the proxy validates the reason locally and forwards the policy fields untouched.
   - The gateway is reached over `GATEWAY_INTERNAL_URL` with the console's internal-CA client certificate (it answers 403 otherwise).

## CI/CD

- `.github/workflows/ci.yml` — gofmt, build, vet, unit tests, web tests (`node --test web/*_test.js`), and gosec on every push/PR.
- `.github/workflows/release.yml` — on push to `main`, builds and publishes `ghcr.io/omarmaarouf18/kyc-reviewer-console` tagged with the commit SHA and `latest`.
- `.github/workflows/contract-sync.yml` — runs contract/integration tests when saas-core fires a `reviewer-api-contract` repository_dispatch on pushes touching reviewer endpoint surfaces.

## Repository Relationship to saas-core

This repo holds original code; it is NOT a subtree mirror of the monorepo. The connection is:

1. Runtime: this service proxies to `auth-service`, `user-service`, and `chat-service` over the internal network.
2. CI: saas-core → `repository_dispatch` → contract test run here.
3. Semantics: ADR-0013 / ADR-0021 boundary enforcement — no reviewer capability may ever be reintroduced into the consumer mobile app binary; all administrative interfaces live here.

