# CONSOLE-CACHE — Static UI Revalidation and Strong Content ETags

Task ID: `CONSOLE-CACHE`  
Branch: `agent/CONSOLE-CACHE-static-revalidate` (created from `main` @ `82f927d`).  
One commit per item. No amend, no push, no merge. The owner merges and releases.

---

## Problem (Owner Report, 2026-11-13)

Following the CONSOLE-V2 deployment, the ops console booted successfully in some browsers but failed in others:

1. **Native ES Modules Without Build Step**: CONSOLE-V2 split the UI into ~30 native ES modules (`web/js/**`) importing each other directly by path/name without a build step or content hashing in the file names.
2. **Missing Static Cache Headers**: `securityHeaders` in `cmd/server/routes.go` set `Cache-Control: no-store` strictly on `/api/*`. Static files were served via `http.ServeFile` with no `Cache-Control` header and no `ETag`, providing only a `Last-Modified` header derived from file checkout mtime.
3. **Browser Heuristic Caching Skew**: In the absence of explicit cache directives, browsers applied heuristic caching (typically ~10% of file age) and reused cached modules without consulting the server. A browser with prior visits loaded an old `index.html` or `main.js` importing newly added or refactored modules (or vice versa), failing on missing exports or 404s, leaving the console blank. Fresh browser profiles loaded correctly.

---

## Items

| # | Item | Status | Description |
|---|------|--------|-------------|
| 1 | Revalidate every static file | Done | `Cache-Control: no-cache` on every response from `staticHandler` |
| 2 | Strong ETag from file content | Done | Strong ETag (`"<hex>"`, first 16 hex chars of content SHA-256) computed at startup |
| 3 | Tests | Done | Route tests for 200, 304, changed file ETags, and security header preservation; smoke test passes |
| 4 | Docs & Worklog | Done | README Security section, `AI_CONTEXT.md`, and this worklog |

---

## Design Choices & Invariants

### 1. `Cache-Control: no-cache` vs Other Strategies
- `no-cache` instructs browsers to store the file but revalidate with the server (`If-None-Match`) before every use.
- `immutable` or a long `max-age` was rejected because static assets do not have content-hashed filenames.
- `Clear-Site-Data` was rejected because it would disrupt active reviewer sessions, clear unrelated credentials, and is unnecessary once revalidation headers are in place.
- `/api/*` keeps `Cache-Control: no-store` to prevent caching sensitive administrative responses or auth tokens on disk.

### 2. Strong ETag Computation
- Computed once at startup for each entry in `staticFiles` using SHA-256 (first 16 hex characters, quoted: `"<hex>"` per RFC 7232).
- Content hashes are indexed by relative path so shared files (e.g., `"/"` and `"/index.html"`) are read from disk and hashed only once.
- Set on the response before invoking `http.ServeFile`. Per Go `net/http` implementation (`serveFile` -> `serveContent` -> `checkPreconditions` -> `checkIfNoneMatch`), `ServeFile` automatically handles `If-None-Match` requests and returns `304 Not Modified` with an empty body.

### 3. Missing File Handling: Request-Time 404 (Chosen)
- **Decision**: Keep existing request-time 404 behavior rather than failing at server startup.
- **Why**:
  1. *Backward compatibility*: Today, any missing file under `staticFiles` 404s at request time.
  2. *Testing flexibility*: Tests using temporary directories (e.g., `TestStatic_ChangedFileDifferentETag`) only populate files under test, rather than needing all 35 static assets.
  3. *Production safety*: Static asset completeness is strictly asserted at build/CI time by `TestStatic_EveryImportedModuleIsServed`, which walks the entire ES module graph and verifies that all referenced files exist on disk.

---

## Verification Output

### 1. `gofmt -l .`
```
(empty output — all files formatted)
```

### 2. `go vet ./...`
```
(empty output — no issues)
```

### 3. `go test ./... -count=1`
```
ok  	github.com/omarmaarouf18/kyc-reviewer-console/cmd/server	0.020s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/config	0.001s
ok  	github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy	0.528s
```

### 4. `node --test web/*_test.js`
```
✔ clicking an account row opens the drawer with its details (291.785696ms)
✔ the drawer renders API values as text (stored XSS regression) (44.840067ms)
✔ the drawer offers reactivate for a suspended account and suspend for an active one (32.05901ms)
✔ the drawer action opens the suspend dialog and the drawer closes on demand (15.589947ms)
✔ api() calls logout and throws on HTTP 401 (140.233931ms)
✔ api() does NOT call logout on HTTP 503 Service Unavailable and returns response (30.202422ms)
✔ submitResolveTicket() catches 503 and surfaces in-app error without crashing or logging out (49.075568ms)
✔ submitResolveTicket() catches 401 gracefully without unhandled promise rejection crash (52.466464ms)
✔ formatBytes formats various file sizes correctly (29.041756ms)
✔ retrieveUserDocs validates mandatory reason before calling API (19.17678ms)
✔ sendTicketAttachment attaches X-Reviewer-Token and sends multipart FormData (17.666757ms)
✔ the audit table renders every record field (146.567423ms)
✔ an unavailable audit source is shown as such (41.082497ms)
✔ audit filters are sent to the API as query parameters (28.776643ms)
✔ audit rows render API values as text only (stored XSS regression) (29.877944ms)
✔ the version policy card shows the current policy (20.90261ms)
✔ updating the version policy needs a reason and posts every field (24.068679ms)
✔ an unavailable version policy shows an explicit message (18.327071ms)
✔ language toggle switches nav labels between Arabic (RTL) and English (LTR) (122.688381ms)
✔ the language toggle re-renders the open page in the new language (52.367064ms)
✔ theme toggle flips the design-token palette on html[data-theme] (27.710124ms)
✔ invalid reviewer token message is localized (32.337805ms)
✔ the jobs list renders status, price and recipient from the API (178.42924ms)
✔ job filters are sent to the API as query parameters (55.912223ms)
✔ the job detail dialog shows phones, addresses and the status history (56.570565ms)
✔ job detail renders API values as text only (stored XSS regression) (38.932562ms)
✔ cancelling a job requires a reason and then posts it (20.320845ms)
✔ completing a stuck COD job posts to the repair endpoint (20.737139ms)
✔ clicking a queue row opens the side panel with the submission details (137.33046ms)
✔ the panel renders API values as text (stored XSS regression) (44.501625ms)
✔ the "a" shortcut approves the selected submission (31.209561ms)
✔ the "r" shortcut selects rejection and a rejection without a reason never reaches the API (69.810277ms)
✔ arrow keys move the selection and Escape closes the panel (30.351068ms)
✔ shortcuts never hijack typing in the reason field (18.588301ms)
✔ the send history renders the sends with their status and counters (174.187072ms)
✔ the composer posts the notification-service contract (80.125804ms)
✔ a missing reason or a missing translation blocks the send (33.09761ms)
✔ an external deep link is refused before the request is sent (24.761293ms)
✔ the dry run resolves the audience size without sending (22.540849ms)
✔ a broadcast to everyone asks for the audience size and pre-fills it (16.653248ms)
✔ a confirmed broadcast sends the confirmed audience size (20.471504ms)
✔ the rate limit is reported without ending the session (14.015087ms)
✔ the send details dialog shows the delivery counters of one job (12.239704ms)
✔ the notification rows render API values as text only (stored XSS regression) (10.90854ms)
✔ the audience selector shows only the fields the kind needs (16.348806ms)
✔ the stuck-COD banner appears when the overview reports stuck jobs (193.879885ms)
✔ the COD banner stays hidden for zero and for an unavailable figure (48.148866ms)
✔ the COD banner action filters the jobs page on the reconciliation status (22.11698ms)
✔ resolving a dispute posts the decision and reason and confirms with a toast (70.177158ms)
✔ rejecting a payout needs a reason, posts it and confirms with a toast (29.76119ms)
✔ resolving a ticket needs a note and confirms with a toast (24.798247ms)
✔ the COD banner is cleared when the session ends (15.673786ms)
✔ the ops pages are localized (Arabic by default, English on request) (17.106735ms)
✔ overview cards render every figure from the API payload (161.777632ms)
✔ unavailable figures are marked unavailable, never rendered as 0 (40.187078ms)
✔ overview figures render API strings as text only (stored XSS regression) (30.281058ms)
✔ overview refresh button re-fetches and replaces the grid (69.457997ms)
✔ a non-object overview payload renders an empty state without crashing (16.744726ms)
✔ the services list renders name, tenant, photo and moderation state (181.260247ms)
✔ service filters are sent to the API as query parameters (56.378865ms)
✔ a service action requires a reason and then posts to its endpoint (71.720803ms)
✔ hiding a visible service and removing its photo use their own endpoints (22.169749ms)
✔ service rows render API values as text only (stored XSS regression) (18.649294ms)
✔ idle timeout is 30 minutes (159.303496ms)
✔ checkIdle signs out after the idle timeout and not before (91.066796ms)
✔ user activity resets the idle clock (41.692783ms)
✔ a stale session is signed out on page load (23.883838ms)
✔ a 401 from any call clears the session (81.44547ms)
✔ sign out wipes sessionStorage, rendered data and in-memory state (22.72993ms)
✔ chat socket carries the token as a subprotocol, never in the URL (11.630102ms)
✔ sign-in clears the token field (6.575915ms)
✔ the upgrade queue is the default view and the badge counts it (169.896909ms)
✔ a queue row shows the tenant, requested plan, request date and owner contact (55.929049ms)
✔ activating a queue item posts the queue contract (tenant_id, subscription_id, duration_days) (39.803763ms)
✔ the queue uses the subscription_id field, not the queue row id (29.852423ms)
✔ switching to the all-subscriptions view loads the full list (24.019992ms)
✔ queue rows render API values as text only (stored XSS regression) (17.183939ms)
✔ an empty queue renders an explicit empty state (20.159304ms)
✔ dispute dialog shows only fields the queue item has (169.179411ms)
✔ dispute rows show no invented route or category (50.914038ms)
✔ payouts are shown in EGP with saas-core statuses (51.307008ms)
✔ dispute dialog renders API fields as text (127.88129ms)
✔ dispute rows render API fields as text (33.296418ms)
✔ account row renders API fields as text (27.133397ms)
✔ ticket message renders sender, content and file name as text (48.197003ms)
✔ ticket rows and resolve dialog render API fields as text (16.307791ms)
✔ payout row renders API fields as text (48.987076ms)
✔ subscription row renders API fields as text (14.433467ms)
✔ KYC queue row and user-docs status bar render API fields as text (16.785253ms)
✔ documents with a scriptable content type open as downloads, not inline (14.807328ms)
ℹ tests 90
ℹ suites 0
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 566.776541
```

### 5. `node scripts/smoke.mjs`
```
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

---

## Deploy Note (Confirmed)

1. **Release Publish**: A push to `main` publishes `ghcr.io/omarmaarouf18/kyc-reviewer-console:<sha>` via `.github/workflows/release.yml`.
2. **Container Update**: On the VM (`quickdelivery-vm`), the owner sets `KYC_CONSOLE_IMAGE_TAG=<sha>` in `/home/deploybot/.env` and redeploys only the console container (`docker compose pull kyc-reviewer-console && docker compose up -d --no-deps kyc-reviewer-console`).
3. **Caddy Reverse Proxy Verification**:
   - Inspected `saas-core/infrastructure/deploy/Caddyfile` lines 36–54 (`kyc.logiclinkeg.tech`).
   - Caddy performs basic auth and forwards directly via `reverse_proxy kyc-reviewer-console:8090`.
   - Caddy does not configure `encode` (gzip/zstd) on this host and touches neither `Cache-Control` nor `ETag`. No Caddy changes are needed.
4. **One-Time Reviewer Step**:
   - Browsers that hold a heuristically cached old copy from before this fix may not re-request modules until their local heuristic cache expires.
   - Each reviewer must do a single hard reload (`Ctrl+Shift+R` / `Cmd+Shift+R`) or clear site data once.
   - From that point onward, `Cache-Control: no-cache` forces every request to revalidate with the server.
5. **Post-Deploy Verification**:
   - DevTools → Network inspecting `/js/main.js` (and other modules) shows `Cache-Control: no-cache` and an `ETag` header.
   - A subsequent reload returns HTTP `304 Not Modified` for all unchanged static assets.
