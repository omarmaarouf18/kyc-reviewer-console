# CONSOLE-SEC — stored-XSS fix and reviewer console hardening

Branch `agent/CONSOLE-SEC-xss-headers` (from `main`). One commit per item,
except item 1, which has two (see Deviations), and item 3, which has a
follow-up commit for the deprecated socket fallback. No commit SHAs are
cited in this file.

## Items

| # | Item | Status |
|---|------|--------|
| 1 | XSS: API data only via `textContent`; payload tests | done |
| 2 | CSP + security headers on every response; tests | done |
| 3 | Idle sign-out, 401/sign-out wipe, token out of URLs/logs | done (backend still needs `?token=` upstream, see follow-ups) |
| 4 | Body limits, method allow-lists, alias removal, safe upstream errors | done |
| 5 | Disputes real fields, payouts in EGP, web tests in CI | done |
| 6 | README Security, AI_CONTEXT, deploy steps | done |

## Item 1 — innerHTML inventory (before → after)

Before = `git show main:web/app.js`. No `insertAdjacentHTML` or `outerHTML`
existed before or after. "API" = the value comes from an API response.

| Before line | Sink | Interpolated data | Risk | After |
|---|---|---|---|---|
| 194 | queue `who` skeleton | none (static); values via `textContent` | safe | unchanged (static) |
| 205 | queue status badge | none | safe | unchanged (static) |
| 216 | queue doc-errors skeleton | none; errors via `textContent` | safe | unchanged (static) |
| 377 | account user skeleton | none; values via `textContent` | safe | unchanged (static) |
| 392–398 | account KYC badges | none | safe | unchanged (static) |
| 406, 414 | account standing badges | none | safe | unchanged (static) |
| 635 | dispute job skeleton | none (`&rarr;` was then printed literally via `textContent`) | safe | replaced by `el()` (item 5: no route) |
| 649 | dispute distance | API `waypoints_count`, distances | **XSS** | `el()` + `num()` |
| 659 | dispute escrow | API `locked_escrow_amount` (`toFixed`) | crash on non-number | `el()` + `num()` |
| 664 | dispute payment badge | API `payment_method` | **XSS** | `badge()`, class from comparison |
| 709 | dispute dialog | API `category`, `pickup_address`, `dropoff_address`, `owner_id`, `employee_id`, `customer_id`, `reconciliation_reason/note` | **XSS** | `detailRow()` rows |
| 826 | subscription tenant | API `tenant_id`, `id` | **XSS** | `el()` |
| 835 | subscription tier badge | API `tier` | **XSS** | `badge()` |
| 852–860 | subscription audit notes | API `activated_by`, `revoked_by`, `reason` | **XSS** | `el()` |
| 1052 | ticket id | API `ticket_id` | **XSS** | `el()` |
| 1057 | ticket customer | API `customer_id` | **XSS** | `el()` |
| 1062 | ticket subject/context | API `subject`, `context_id` | **XSS** | `el()` |
| 1070 | ticket status badge | API `status` | **XSS** | `badge()` |
| 1075 | ticket agent | API `assigned_agent_id` | **XSS** | `el()` |
| 1165 | resolve-ticket dialog | API `context_id`, `assigned_agent_id`, `created_at` | **XSS** | `detailRow()` rows |
| 1298 | payout id | API `id` | **XSS** | `el()` |
| 1303 | payout tenant | API `tenant_id` | **XSS** | `el()` |
| 1308 | payout amount | API `amount` (`Number()`) | safe | `el()` (item 5: EGP) |
| 1321 | payout status badge | API `status` | **XSS** | `badge()` |
| 1340 | payout rejection reason | API `rejection_reason` | **XSS** | `el()` |
| 1479, 1493 | chat notices | none, but `style="..."` (CSP-blocked) | CSP | `el('div','… chat-notice')` + CSS class |
| 1484, 1524 | chat clear | none | safe | `textContent = ''` |
| 1497 | chat history error | `err.message` + `style` | text injection / CSP | `el()` |
| 2001, 2051 | doc links clear | none | safe | `textContent = ''` |
| 2048 | user-docs status bar | API `kyc_status`, `kye_status` in text **and** class attribute | **XSS** | `badge(verificationBadgeClass(...))` |

After (`grep -nE "innerHTML|insertAdjacentHTML|outerHTML" web/app.js`):
only the static skeleton/badge lines listed as "unchanged" above, plus the
explanatory comment line.

Also part of item 1: documents and chat attachments open from `blob:` URLs,
which run in the console origin. `safeBlobUrl()` keeps only
JPEG/PNG/GIF/WebP/PDF inline and turns anything else (e.g. an uploaded
`text/html` "attachment") into a download.

Tests: `web/testdom.js` (dependency-free DOM that parses the real
`index.html` and runs the real `app.js` in a `vm` context) and
`web/xss_test.js` (dispute dialog + rows, account row, ticket messages incl.
system message and file name, ticket rows + resolve dialog, payout rows,
subscription row, KYC queue + user-docs status bar, blob types).
**Negative control**: the new XSS tests run against `main`'s `app.js`
gave `ℹ pass 2` / `ℹ fail 7`. The account row and chat message were already
safe on main.

## Item 2 — headers

`curl` against a locally running server (`go build ./cmd/server`, upstreams
pointed at a local stub, reviewer value redacted):

```
$ curl -sI http://localhost:18090/
HTTP/1.1 200 OK
Accept-Ranges: bytes
Content-Length: 20906
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://localhost:18090 ws://localhost:18090; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
Content-Type: text/html; charset=utf-8
Last-Modified: Wed, 28 Oct 2026 07:53:02 GMT
Permissions-Policy: camera=(), microphone=(), geolocation=()
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Date: Wed, 28 Oct 2026 07:53:29 GMT

$ curl -s -D - -o /dev/null -H "X-Reviewer-Token: <stub>" http://localhost:18090/api/queue
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://localhost:18090 ws://localhost:18090; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
Content-Type: application/json
Permissions-Policy: camera=(), microphone=(), geolocation=()
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Date: Wed, 28 Oct 2026 07:53:29 GMT
Content-Length: 247
```

(`curl -sI` on `/api/queue` answers 405 since item 4: HEAD is not on the
route's allow-list. That is why the API request above is a GET.)

`index.html` had no inline script, handler or style attribute. The only
CSP-incompatible markup was the `style="..."` chat notices built in
`app.js`, fixed in item 1.

**Document viewer / attachments under the CSP**: checked with headless
Google Chrome over CDP against the local server + stub. Clicking the real
buttons (with user gesture) opened popups: ID Front →
`contentType: image/png`, image 1x1 rendered; Selfie →
`application/pdf`; chat thumbnail `blob: 1x1`; chat PDF →
`application/pdf`; chat image full view → `image/png`. The stub's
`text/html` document became a download (its popup closed immediately). No CSP
violation appeared in the console. The only console error was the stub having no
WebSocket endpoint (`Unexpected response code: 404`).

## Item 3 — session hygiene, token proof

- `IDLE_TIMEOUT_MS = 30 * 60 * 1000`, checked every 30 s and on page load.
  Last activity (pointerdown/keydown/wheel/touchstart) is kept in
  sessionStorage. Side effect: a session opened before this deploy has no
  stamp, so it is signed out once on its next page load.
- A 401 from any call, the idle timeout and Sign out run one `logout()`:
  `sessionStorage.clear()`, socket closed, all targets/filters reset,
  tables/dialogs/chat/inputs emptied. Attachment upload now goes through
  `api()` (before, a 401 there did not end the session; the negative
  control fails exactly on that case).
- Socket: browser `new WebSocket('/api/chat/ws', ['kyc-console-auth', token])`.
  The proxy reads the token from `Sec-WebSocket-Protocol`, strips that
  header, builds upstream `/chat/ws?token=` itself, drops the client query,
  and echoes `kyc-console-auth` on 101. chat-service only reads
  `?token=` (`HandleWebSocket` in saas-core), so the upstream hop still
  carries it: **follow-up**.
- Deprecated fallback kept: a client offering no subprotocol may still
  send `?token=`, because saas-core `tests/e2e` (`ConnectConsoleWS`,
  `cuj_i_test.go`) dials the console that way. The console UI never does.
- Upstream failure logs used to print `*url.Error` text, i.e. the full
  upstream URL incl. `?token=` (document view tokens; with the socket, the
  reviewer token). They now log the unwrapped error and the path without
  query (`upstreamErrText`, `stripQuery`, ReverseProxy `ErrorHandler`).

Browser check (headless Chrome, CDP): `Network.webSocketCreated` URL was
`ws://localhost:18090/api/chat/ws` (no token). The handshake request carried
`Sec-WebSocket-Protocol`. The stub logged `GET /chat/ws?token=<redacted> ws-proto=""`.
After clicking Sign out: `storageKeys: []`, payout rows 0, login visible.

Grep proof (`web/app.js`, Go logging):

```
$ grep -nE "tokenKey|reviewer_token" web/app.js
6:const tokenKey = 'reviewer_token';
74:  return { 'X-Reviewer-Token': sessionStorage.getItem(tokenKey) || '' };
192:  if (sessionStorage.getItem(tokenKey)) sessionStorage.setItem(lastActivityKey, String(Date.now()));
198:  if (!sessionStorage.getItem(tokenKey)) return false;
1641:  const token = sessionStorage.getItem(tokenKey) || '';
1746:  if (!sessionStorage.getItem(tokenKey)) return;
1790:  sessionStorage.setItem(tokenKey, tok);
2268:const existingSessionToken = sessionStorage.getItem(tokenKey);

$ grep -nE "console\.(log|warn|error|info|debug)" web/app.js
1664:        console.error('Error handling WS message', e);
1668:      console.warn('WebSocket error in ticket chat', e);
1671:    console.error('Failed to initialize WebSocket', e);
2027:    console.error('Failed to open attachment:', err);

$ grep -nE "token=" web/app.js
371:    const res = await api(`/api/documents/view?token=${encodeURIComponent(viewToken)}`);
1716:            const r = await api(`/api/chat/attachments/view?token=${encodeURIComponent(urlToken)}`);
2018:    const res = await api(`/api/chat/attachments/view?token=${encodeURIComponent(token)}`);

$ grep -nE "log\.(Print|Fatal)" cmd/server/*.go internal/proxy/proxy.go internal/config/config.go
cmd/server/main.go:24:		log.Fatalf("[CONSOLE] config error: %v", err)
cmd/server/main.go:31:			log.Fatalf("[CONSOLE] failed to load TLS keypair: %v", err)
cmd/server/main.go:35:			log.Fatalf("[CONSOLE] failed to read CA cert: %v", err)
cmd/server/main.go:39:			log.Fatalf("[CONSOLE] failed to parse CA cert from %s", cfg.TLSCAPath)
cmd/server/main.go:63:	log.Printf("[CONSOLE] listening on %s (auth-service: %s, env: %s)", addr, cfg.AuthServiceURL, cfg.AppEnv)
cmd/server/main.go:65:		log.Fatalf("[CONSOLE] server exited: %v", err)
cmd/server/main.go:74:		log.Printf("[CONSOLE] %s %s %s", r.Method, sanitizeForLog(r.URL.Path), time.Since(start))
internal/proxy/proxy.go:82:		log.Printf("[CONSOLE] failed to build upstream request for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:94:		log.Printf("[CONSOLE] upstream call to %s failed: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:106:		log.Printf("[CONSOLE] failed to relay upstream response for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:122:		log.Printf("[CONSOLE] failed to build upstream multipart request for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:136:		log.Printf("[CONSOLE] upstream multipart call to %s failed: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:148:		log.Printf("[CONSOLE] failed to relay upstream multipart response for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
internal/proxy/proxy.go:799:		log.Printf("[CONSOLE] chat websocket upstream failed: %v", upstreamErrText(err))
```

(Captured on the item 3 tree; line numbers in `proxy.go` moved in item 4.)
The `token=` lines are per-file signed **document/attachment view tokens**,
not the reviewer token. The console logs request paths only (`r.URL.Path`,
no query). `TestUpstreamFailureLogs_NeverContainTokens` asserts neither
token appears in logs.

## Item 4 — alias grep proof

```
$ grep -rn "/admin/payouts" web/ internal/ cmd/ README.md docs/
cmd/server/routes.go:33:	mux.HandleFunc("/admin/payouts", p.Payouts)
cmd/server/routes.go:35:	mux.HandleFunc("/admin/payouts/reject", p.RejectPayout)
internal/proxy/proxy.go:536:// Payouts proxies GET /admin/payouts to user-service.
internal/proxy/proxy.go:542:	upstreamPath := "/admin/payouts"
internal/proxy/proxy.go:554:// RejectPayout proxies POST /admin/payouts/reject with mandatory reason validation.
internal/proxy/proxy.go:586:	p.forwardToService(w, r, p.userServiceURL, "/admin/payouts/reject")
internal/proxy/proxy_test.go:741:		if stub.gotPath != "/admin/payouts" {
internal/proxy/proxy_test.go:818:		if stub.gotPath != "/admin/payouts/reject" {
README.md:83:   - Payout rejection with mandatory reason (1–1000 chars), proxying to `user-service` (`POST /admin/payouts/reject`) to perform atomic Compare-and-Swap (CAS) state transition from `pending` to `rejected` and automatically restore the user's withdrawable wallet balance (authorized via commit `f5b7b6a`).
docs/ARCHITECTURE.md:66:3. **Upstream Action**: `user-service` executes `POST /admin/payouts/reject`, performing atomic Compare-and-Swap (CAS) state transition on the payout request from `pending` to `rejected`, restores the user's withdrawable wallet balance, records an audit log, and ships security event `ADMIN_PAYOUT_REJECTED`.

$ grep -rn "/api/payouts" web/app.js
web/app.js:1397:    const res = await api(`/api/payouts?${params.toString()}`);
web/app.js:1528:    const res = await api('/api/payouts/reject', {
web/app.js:1753:      api('/api/payouts?status=requested&page=1&limit=1').then(r => r.ok ? r.json() : {}),
```

Nothing in `web/` uses the aliases. The other hits are the **upstream**
user-service paths, which are unchanged. saas-core `tests/` has no
reference to `admin/payouts` or `api/payouts` (empty grep). Only the two
console routes in `routes.go` were removed.

Body limits: JSON POST 64 KB (`Content-Length` check + `MaxBytesReader`,
413, chunked too); uploads 10 MB + 64 KB framing (413, previously silently
truncated by `io.LimitReader`). GET bodies are no longer forwarded.
Upstream errors >= 400 are re-encoded to `error/message/code/request_id`,
and any other body becomes `{"error":"upstream error"}` with the same
status. **Negative control** (old `proxy.go` with only the new constants
added): `TestJSONBodyLimit_EveryPOSTHandler`, `TestUploadBodyLimit`,
`TestUpstreamErrors_OnlyJSONContractRelayed` and `TestGETBodyNotForwarded`
all FAIL. `TestUpstreamSuccess_StreamedUnchanged` passes on both (it is a
regression guard).

## Item 5 — UI fixes

- Disputes: saas-core's `AdminReconciliationJobItem` (user-service
  `models.go`, same on saas-core `main`) has `id, tenant_id, owner_id,
  employee_id (omitempty), customer_id, service_id, booked_distance,
  actual_distance, waypoints_count, locked_escrow_amount, actual_amount,
  payment_method, status, reconciliation_note, reconciliation_reason,
  created_at, updated_at`. **Discrepancy with the brief**: `employee_id`
  exists (omitempty), and no route points are serialised. The UI shows
  only present fields: Job/Service columns, dialog rows omitted when
  empty, courier row only when `employee_id` is set.
- Payouts: EGP (table + reject dialog). Also found: saas-core
  `PayoutStatus` is `requested/approved/paid/rejected`, but the UI filtered
  and badged a non-existent `processed`. The filter and badge now use the real values.
- CI: `actions/setup-node@v4` (Node 24) + `node --test web/*_test.js`.
- Negative control: the 3 `web/ui_test.js` tests fail on the item 4 code.

## Verification (final tree)

```
$ gofmt -l .
$ go vet ./...
$ go test ./... -count=1
ok  	github.com/omarmaarouf18/kyc-reviewer-console/cmd/server	0.008s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/config	0.001s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy	0.026s
$ node --test web/*_test.js  (summary lines)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 197.982344
```

## Owner deploy steps

1. Review and merge `agent/CONSOLE-SEC-xss-headers` into `main`, then push
   `main`.
2. `release.yml` builds and pushes
   `ghcr.io/omarmaarouf18/kyc-reviewer-console:<full commit sha>` (and
   `latest`). Wait for it to go green.
3. On the VM, in `/home/deploybot/.env`, set
   `KYC_CONSOLE_IMAGE_TAG=<that sha>` (a pinned tag, not `latest`).
   saas-core-deploy's compose reads
   `ghcr.io/omarmaarouf18/kyc-reviewer-console:${KYC_CONSOLE_IMAGE_TAG:-latest}`
   for service `kyc-reviewer-console`.
4. Redeploy only that service from the compose directory:
   `docker compose pull kyc-reviewer-console && docker compose up -d --no-deps kyc-reviewer-console`.
5. Smoke: `curl -sI https://kyc.logiclinkeg.tech/` shows the CSP;
   sign in, open a document, open a ticket chat (socket connects), then
   Sign out. Reviewers with an open tab are signed out once (no activity
   stamp yet).

## Deviations

- Item 1's code commit went in without its AI_CONTEXT.md entry (the edit
  had not applied when the commit ran). It was added in the next commit,
  "item 1 - AI_CONTEXT.md for the XSS fix", rather than amending.
- Small additions beyond the brief, each inside its item: blob type
  allow-list (1), static-file allow-list so test files are not served (2),
  URL-free upstream error logs (3), GET bodies not forwarded (4), payout
  status values (5). `escapeHtml` was not added: every sink uses
  `textContent`, so it would be dead code.

## Not verified

- GitHub CI was not run (no push). The new Node step was run locally only, as
  `node --test web/*_test.js`.
- Not tested against the real saas-core stack. Browser checks used a local
  stub upstream. The real chat-service socket was not exercised end to end
  through the console.
- The deploy steps were not executed. The compose directory on the VM is
  assumed to be `/home/deploybot` (where `.env` lives).
- Old browsers that do not treat `'self'` as covering `ws(s):` rely on the
  explicit `wss://<host>` entry. Only current Chrome was tried.

## Follow-ups (saas-core)

1. chat-service `GET /chat/ws`: accept the token from a header (e.g.
   `X-Reviewer-Token`, set by the console proxy) so it no longer travels in
   the upstream query string.
2. saas-core `tests/e2e` `ConnectConsoleWS`: dial with
   `Subprotocols: []string{"kyc-console-auth", token}`. Then remove the
   console's deprecated `?token=` fallback.
3. user-service reconciliation queue item: add pickup/dropoff address,
   category and route points if reviewers need them (the console now
   simply omits them).
4. Console side, optional: `/api/documents/user` still takes the audit
   `reason` in the query string (not logged by the console, but visible
   to upstream access logs); moving it to a POST body needs an
   auth-service change.
