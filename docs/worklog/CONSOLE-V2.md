# CONSOLE-V2 — the reviewer & operations console rebuild

Branch `agent/CONSOLE-V2-ops-console` (from `main`). One commit per item.
No commit SHAs are cited in this file.

The rebuild turns the single-file console into a complete operations
console: native ES modules with an explicit static allow-list, a shell with
Arabic (RTL) / English (LTR) and light/dark themes, a shared UI kit, and
twelve pages. The backend grows the missing admin endpoints (audit, app
version policy, admin announcements) and starts to send the reviewer's
browser IP to the internal services.

The contract of record is `saas-core`'s `docs/api/ADMIN_API.md`. Every
difference between that document and the running services is listed in
[Endpoint differences vs the documentation](#endpoint-differences-vs-the-documentation).

## Items

| # | Item | Commit message | Status |
|---|------|----------------|--------|
| 1 | `web/app.js` split into native ES modules under `web/js/` (core, pages, shell), explicit static allow-list, no build step | `CONSOLE-V2: item 1 - split web/app.js into ES modules` | done |
| 2 | Shell (topbar + sidebar), AR/EN with RTL, light/dark theme, token-based CSS, bundled IBM Plex Sans Arabic woff2 | `CONSOLE-V2: item 2 - shell, i18n (AR/EN + RTL), light/dark theme, design-token CSS, bundled woff2 fonts` | done |
| 3 | Overview page (`GET /api/overview`) as the landing page | `CONSOLE-V2: item 3 - overview page (GET /admin/overview) as the console landing page` | done |
| 4 | KYC queue review side panel with keyboard shortcuts | `CONSOLE-V2: item 4 - KYC queue review side panel with keyboard shortcuts` | done |
| 5 | Accounts directory with an account drawer | `CONSOLE-V2: item 5 - accounts drawer (list + overlay account details)` | done |
| 6 | Jobs page: search, detail dialog, cancel / complete-stuck-COD | `CONSOLE-V2: item 6 - jobs search, job detail and support mutations` | done |
| 7 | Marketplace services moderation (hide / unhide / photo) | `CONSOLE-V2: item 7 - marketplace services moderation` | done |
| 8 | Subscriptions, queue-first (pending upgrades before the full list) | `CONSOLE-V2: item 8 - subscriptions queue-first` | done |
| 9 | Disputes / tickets / payouts on the shared UI kit + the stuck-COD banner | `CONSOLE-V2: item 9 - disputes/tickets/payouts on the shared UI kit + stuck-COD banner` | done |
| 10 | Audit viewer + app version policy (backend + pages) | `CONSOLE-V2: item 10 - audit viewer and app version policy` | done |
| 11 | Admin announcements & broadcast notifications (backend + page) | `CONSOLE-V2: item 11 - admin announcements and broadcast notifications` | done |
| 12 | Reviewer client IP (`X-Console-Client-IP`), browser smoke test, screenshots, this worklog | `CONSOLE-V2: item 12 - reviewer client IP, browser smoke test and worklog` | done |

## What the console looks like now

Twelve pages, in this order:

1. **Overview** — operational counters (pending KYB/KYE reviews, pending
   payment subscriptions, open/assigned tickets, GPS disputes, stuck COD
   jobs, new/suspended accounts, today's jobs by status). A figure that
   comes back as `"unavailable"` is shown as such, never as `0`.
2. **Queue** — the pending KYB/KYE submissions with a review side panel
   (`↑`/`↓`, `j`/`k` to move, `Enter` to open, `a` to approve, `r` to
   reject, `Esc` to close, `?` for the shortcut help).
3. **Accounts** — the directory with a drawer that holds the account
   details and the suspend / reactivate actions.
4. **Jobs** — search over the job id, customer, status and date range; a
   detail dialog with the full job model; cancel and complete-stuck-COD.
5. **Reconciliation** — the escrow dispute queue and the resolve dialog.
6. **Subscriptions** — the upgrade queue first, the full subscription list
   behind a segmented switcher; activation posts the queue item's
   `subscription_id`.
7. **Services** — marketplace moderation; the photos are external object
   storage links (`rel="noopener noreferrer"`, `target="_blank"`).
8. **Tickets** — the support queue with the chat socket.
9. **Payouts** — the payout requests and their rejection.
10. **Audit** — the merged audit log with the per-source status strip.
11. **App versions** — the version policy card and its update dialog.
12. **Notifications** — the announcement composer and the send history.

A shell-level banner warns when jobs are stuck in escrow reconciliation
(COD). It is fed by the overview counter and by the badge refresh, the
highest known count wins, and its action jumps to the jobs page filtered
on `escrow_reconciliation_required`.

## The shared UI kit

`web/js/core/ui/` holds the four pieces every page uses:

- `table.js` — `tableController` (rows, empty state, pagination) and
  `changePage`.
- `dialog.js` — `openDialog` / `closeDialog` over the native `<dialog>`.
- `toast.js` — the toast notifications.
- `search.js` — the debounced search box.

`web/js/core/` holds the rest: `api.js` (the reviewer token, the 401 →
sign-out rule, the error mapper), `state.js` (every mutable page state,
reset on sign-out), `session.js`, `router.js` (hash routing),
`i18n.js` (Arabic default, English, RTL, `console_lang` in
`localStorage`), `theme.js` (light/dark, `console_theme`),
`dom.js` (`el`, `show`, `hide`, `badge`), `format.js` and
`cod-banner.js`.

`web/js/main.js` wires the shell and has no top-level side effects;
`web/js/boot.js` is the browser entry (`<script type="module">`), and
`web/js/app.js` is the aggregator the tests import.

## Security rules kept from CONSOLE-SEC

- **No API data is ever interpolated into HTML.** Every value reaches the
  DOM through `textContent` / `createElement`. The pages that render
  reviewer-controlled strings (audit records, notification sends, job
  details) have a stored-XSS regression test.
- **Strict CSP, no build step, no CDN.** The only script is
  `/js/boot.js`; the only font is the bundled woff2. The security headers
  are unchanged.
- **Explicit static allow-list, no wildcards.** `cmd/server/routes.go`
  lists every file the browser may fetch.

### The static allow-list bug the smoke test found

`/js/core/theme.js` was imported by `main.js` and by `app.js` but was
missing from the allow-list. The module graph therefore 404'd in the
browser and **the console booted nothing** — a silent, total outage that
the Go tests and the DOM tests could not see (they import the modules
from disk, they do not fetch them over HTTP).

Two changes close the hole:

- `cmd/server/routes.go` serves `/js/core/theme.js`.
- `cmd/server/routes_test.go` has
  `TestStatic_EveryImportedModuleIsServed`: it walks the ES module graph
  under `web/js`, resolves every relative import and fails when the
  imported file is not in the allow-list (or is in it but missing on
  disk). The test was verified against the bug: removing the entry again
  makes it fail with
  `../../web/js/main.js imports js/core/theme.js, which is not in the static allow-list`.

## The reviewer client IP (`X-Console-Client-IP`)

`ADMIN_API` § 1.3: auth-service keys its per-IP reviewer rate limit on
`X-Console-Client-IP` — only when the request also carries a valid
`X-Internal-Token` and the value parses as an IP — and **never** on
`X-Forwarded-For` / `X-Real-IP`, because rotating those used to reset the
budget.

The console now:

1. reads the inbound `X-Forwarded-For`, which the edge (Caddy) sets, and
   takes the **left-most** entry that parses as an IP;
2. sends it upstream as `X-Console-Client-IP`;
3. **never** forwards `X-Forwarded-For` or `X-Real-IP` to an internal
   service, so a browser can never pick another reviewer's rate-limit
   key.

The header is set on every upstream request: JSON (`forwardToService`),
multipart (`forwardMultipartToService`) and the chat WebSocket (the
reverse-proxy `Director`). An unknown IP sends no header at all and the
services fall back to the TCP peer (the console container), exactly as
before.

On the WebSocket path the outbound `X-Forwarded-For` is set to a **nil**
value (Go issue 38079): with the `Director` API, `ReverseProxy` appends the
console's own peer IP to the header *after* the Director ran, so every
reviewer would have shared one key upstream. The socket test
(`TestChatWebSocket_CarriesTheReviewerIPOnly`) was verified against that
behaviour: reverting the nil value to a plain `Del` makes it fail with
`X-Forwarded-For must not reach chat-service`.

Accepted forms: a bare IPv4/IPv6 address, an IPv4 address with a port
(`203.0.113.10:443`) and a bracketed IPv6 with a port
(`[2001:db8::1]:443`). The value is canonicalised with `net.ParseIP`.

## Item 12 — the browser smoke test

`scripts/smoke.mjs` is a dependency-free browser smoke test:

- it builds the **real** Go binary and starts it against a stub of the
  internal services (auth / user / chat / notification / gateway);
- it drives a headless Chrome over the DevTools protocol using Node's
  global `WebSocket` (Node 24 — no npm install, no Playwright);
- it asserts that the shell boots, that the overview is the landing page,
  that the counters render, that Arabic/RTL and the light theme are the
  defaults, that the language and theme toggles work (and that the open
  page is re-rendered in the new language), that **every** page renders,
  that the API is proxied, and that **no** console error, exception or
  CSP violation was logged;
- it writes the reference screenshots into `docs/screens/`:
  `console-ar-light.png` (Arabic, RTL, light) and `console-en-dark.png`
  (English, LTR, dark).

Usage:

```
node scripts/smoke.mjs                 # writes docs/screens/
node scripts/smoke.mjs --screens /tmp/x
node scripts/smoke.mjs --headful
```

Requirements: Go, Node ≥ 24 and a Chrome/Chromium binary (override with
`CHROME_PATH`).

The smoke test also drove the language-toggle fix: the page content is
rendered by the page modules, not by the shell translation pass, so the
toggle now calls `router.render()` to re-render the open route.

## Endpoint differences vs the documentation

`saas-core`'s `docs/api/ADMIN_API.md` is the contract of record. The
running services differ in the following places; the console follows the
**services** (they are what actually answers), and the list is kept here
so the document can be corrected.

| # | Document says | The service does | The console does |
|---|---------------|------------------|-----------------|
| 1 | `POST /admin/subscriptions/activate` takes `{tenant_id, plan, reason}` | user-service takes `{tenant_id, subscription_id, duration_days}` (`tenant_id` **or** `subscription_id` is required; the plan is not an input) | posts `{tenant_id, subscription_id, duration_days}` from the queue item |
| 2 | — | user-service registers `/admin/subscriptions` **and** `/admin/subscriptions/queue` (and the `/users/admin/...` aliases) | calls `/admin/subscriptions/queue` for the queue and `/admin/subscriptions` for the full list |
| 3 | — | `GET /admin/audit` is owned by **auth-service** (the merged fan-out over every service's own `admin_audit` collection) and answers with a `sources` map of `ok` / `unavailable` | proxies auth-service and renders the per-source status strip |
| 4 | — | `GET|PUT /admin/version` on the api-gateway is client-certificate protected (403 without the internal-CA certificate) and `GET /admin/internal/audit` is internal-token only | reaches the gateway over `GATEWAY_INTERNAL_URL` with the console's internal-CA client certificate |
| 5 | — | the gateway also accepts `POST /admin/version` | the console exposes `GET` + `PUT` only |
| 6 | the send status is `"completed"` | the service's statuses are `queued` / `sending` / `done` / `failed` | renders the four real values (unknown values fall back to a neutral badge) |
| 7 | the send record has `is_test_send` | the stored record has **no** `is_test_send` field | the detail row appears only when the field is present |
| 8 | the upstream validates the audience | upstream validates only `audience.kind`; the console also enforces the documented user / role / tenant identifiers | the console refuses an incomplete audience locally (400 before the call) |
| 9 | the deep link allow-list | the service's regex also accepts `/plans`, `/subscriptions`, `/subscription`, `/kyc`, `/kyb`, `/kye` | the console mirrors the service's regex exactly (including the extra routes) |
| 10 | `GET /admin/overview` | the real field names are `pending_kyb_kye`, `pending_payment_subscriptions`, `open_tickets`, `assigned_tickets`, `gps_disputes`, `stuck_cod_jobs`, `new_accounts_today`, `new_accounts_7d`, `suspended_accounts`, `jobs_today{pending_dispatch,active,completed,cancelled}` | the console renders exactly these keys |

## Verification (final tree)

```
$ gofmt -l cmd internal
$ go vet ./...
$ go test ./... -count=1
ok  	github.com/omarmaarouf18/kyc-reviewer-console/cmd/server	0.013s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/config	0.001s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy	0.041s
$ node --test web/*_test.js
ℹ tests 90
ℹ suites 0
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 642.099006
$ node scripts/smoke.mjs
ok   the app view is shown after the session bootstrap
ok   the sidebar lists every page
ok   the default page is the overview
ok   the overview renders its counters
ok   Arabic is the default language (RTL)
ok   the light theme is applied
ok   the overview shows the stubbed figures
ok   the language toggle switches to English (LTR)
ok   the theme toggle switches to dark
ok   the nav is translated
ok   the rendered page follows the language switch
ok   the queue page renders
ok   the accounts page renders
ok   the jobs page renders
ok   the reconciliation page renders
ok   the subscriptions page renders
ok   the services page renders
ok   the tickets page renders
ok   the payouts page renders
ok   the audit page renders
ok   the versions page renders
ok   the notifications page renders
ok   the console proxies the API to the internal services
ok   no console error, exception or CSP violation was logged

24 checks passed, 0 failed
screenshots: docs/screens/console-ar-light.png, docs/screens/console-en-dark.png
```

The web suite grew from 27 tests (after CONSOLE-SEC) to **90**: every
pre-existing test is unchanged and still passes.

## Owner deploy steps

1. Review and merge `agent/CONSOLE-V2-ops-console` into `main`, then push
   `main`.
2. `release.yml` builds and pushes
   `ghcr.io/omarmaarouf18/kyc-reviewer-console:<full commit sha>` (and
   `latest`). Wait for it to go green.
3. On the VM, in `/home/deploybot/.env`, set
   `KYC_CONSOLE_IMAGE_TAG=<that sha>` (a pinned tag, not `latest`).
4. Redeploy only that service from the compose directory:
   `docker compose pull kyc-reviewer-console && docker compose up -d --no-deps kyc-reviewer-console`.
5. Check the new configuration reaches the container:
   `NOTIFICATION_SERVICE_URL=https://notification-service:3004` and
   `GATEWAY_INTERNAL_URL=https://api-gateway:8080` (both have defaults;
   set them only if the services live elsewhere).
6. Smoke: sign in, open the overview, the audit log, the app version card
   and the notifications page. The audit page and the version card are
   the two pages that need the new upstream configuration.
7. Pin the image tag (step 3) — never leave `latest` in production.

## Deviations

- The `X-Console-Client-IP` is derived from the **edge-set**
  `X-Forwarded-For` (left-most valid IP), as specified. If the console is
  ever exposed without the edge in front of it, the header is not set and
  the services fall back to the TCP peer.
- The smoke test is a CDP runner instead of Playwright: the repository has
  no npm dependency for the browser tests and the console has no build
  step. The runner needs Node ≥ 24 (global `WebSocket`) and a local
  Chrome; it is not part of `node --test web/*_test.js`.
- The item-12 commit also contains the `/js/core/theme.js` allow-list
  fix. It is a one-line fix plus its regression test and belongs to the
  item that found it.
- The notification proxy validates the send contract **locally** (reason,
  bilingual title/body, deep link, audience) before the call, although the
  service validates it too. This is the CONSOLE-SEC pattern (validate
  locally, forward the untouched body) and gives the reviewer an instant
  answer instead of a round trip.

## Not verified

- GitHub CI was not run (no push). The Go and Node suites were run
  locally, and the smoke test was run locally.
- The console was **not** tested against the real saas-core stack. The
  browser smoke test uses a local stub upstream; the real chat-service
  socket was not exercised end to end through the console, and the
  api-gateway's client certificate was not presented to the real gateway.
- The deploy steps were not executed. The compose directory on the VM is
  assumed to be `/home/deploybot` (where `.env` lives).
- Only current Chrome (156) was tried in the smoke test.

## Follow-ups

1. **saas-core**: correct `ADMIN_API.md` § 5 (the activate body) and § 12
   (the send status values and `is_test_send`) — the endpoint differences
   table above.
2. **saas-core**: `POST /admin/version` on the gateway has no console
   equivalent on purpose. Confirm that GET + PUT is the intended
   surface, or add the POST to the console's method allow-list.
3. **saas-core**: the console sends `X-Console-Client-IP` on every
   upstream request. `user-service` and the api-gateway already forward it
   to auth-service; confirm that `chat-service` and
   `notification-service` do the same for their reviewer verification.
4. **Console**: the subscriptions activation posts `duration_days`; the
   queue item does not always carry it. A default (e.g. 30 days) would
   remove the manual step.
5. **Console**: the audit page polls on demand only. A live tail (with a
   bounded refresh interval) would help during an incident.
6. **Console**: the smoke test could also assert the sign-out flow and the
   401 handling in the browser (the DOM tests cover them).
