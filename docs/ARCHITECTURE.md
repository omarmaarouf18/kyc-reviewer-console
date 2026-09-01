# Architecture: Reviewer & Operations Console Architecture

This document explains the end-to-end operational architecture of the standalone Operations Console (`kyc-reviewer-console`), its multi-service proxy model, and event propagation flows across downstream microservices (`auth-service`, `user-service`, `chat-service`, and `notification-service`).

---

## 1. Multi-Service Two-Token Proxy Model

All administrative actions across the 5 console tabs follow a uniform two-token security contract:

```
Browser (sessionStorage)
   │
   │  HTTPS: X-Reviewer-Token: <reviewer_secret>
   ▼
kyc-reviewer-console (internal proxy on saas-net)
   │
   │  Injects X-Internal-Token: <internal_service_token>
   │  Forwards X-Reviewer-Token: <reviewer_secret>
   ▼
Internal Microservice (auth-service / user-service / chat-service)
   │
   ├── 1. Validates X-Internal-Token matches internal service secret
   ├── 2. Queries auth-service GET /auth/reviewer/verify to authenticate reviewer
   ├── 3. Executes atomic Compare-and-Swap (CAS) state transition
   ├── 4. Records structured audit log & ships security event via handlerutil.ShipSecurityEvent
   └── 5. (If applicable) Dispatches asynchronous notification via notification-service POST /notifications/send
```

---

## 2. Tab-by-Tab Execution Flows

### 2.1 Tab 1: KYC/KYB/KYE Document Review (ADR-0021)
1. **Console Action**: Reviewer approves or rejects submission via `POST /api/review` (`action: approve | reject`, `reason`).
2. **Local Proxy Validation**: Enforces mandatory reason (1–1000 characters) on rejections before forwarding.
3. **Upstream Action**: `auth-service` executes `POST /auth/kyb-kye/review`, CAS-updating user status from `pending_super_admin_approval` to `approved` or `rejected`, writes `KYC_REVIEWED` audit log.
4. **Notification**: `auth-service` fires goroutine to `notification-service` `POST /notifications/send` (`type: kyc_approved | kyc_rejected`).
5. **Consumer App**: Customer or courier app receives SSE notification; rejection displays in-app dialog with reason.

### 2.2 Tab 2: Accounts Directory & Suspension (ADR-0022)
1. **Console Action**: Reviewer lists accounts (`GET /api/accounts`) or suspends/reactivates (`POST /api/accounts/suspend`, `POST /api/accounts/reactivate`).
2. **Local Proxy Validation**: Enforces mandatory reason (1–1000 characters) on suspensions before forwarding.
3. **Upstream Action**: `auth-service` executes CAS update on `users` collection, writes `ACCOUNT_SUSPENDED` / `ACCOUNT_REACTIVATED` audit log, invalidates active JWT sessions in Redis (`jwtutil.RevokeAllUserTokens`), and blocks future login / 2FA attempts.
4. **Notification**: `auth-service` fires goroutine to `notification-service` `POST /notifications/send` (`type: account_suspended | account_reactivated`).

### 2.3 Tab 3: Disputes & Escrow Reconciliation (ADR-0023 Module 1.1)
1. **Console Action**: Reviewer inspects disputed jobs (`GET /api/reconciliation/queue`) and resolves (`POST /api/reconciliation/resolve`, `decision: release_to_employee | refund_to_customer`, `reason`).
2. **Local Proxy Validation**: Enforces mandatory reason (1–1000 characters) and valid decision enum before forwarding.
3. **Upstream Action**: `user-service` executes atomic CAS transition on `jobs` collection from `escrow_reconciliation_required` to `completed` (releasing funds to employee) or `cancelled` (refunding escrow to customer), updates wallet balances, and logs security event `DISPUTE_RECONCILIATION_RESOLVED`.
4. **Notification**: `user-service` notifies tenant owner and involved parties via `notification-service`.

### 2.4 Tab 4: Subscriptions Management (ADR-0023 Module A)
1. **Console Action**: Reviewer lists subscriptions (`GET /api/subscriptions`), activates paid plan (`POST /api/subscriptions/activate`, `duration_days`), or revokes plan (`POST /api/subscriptions/revoke`, `reason`).
2. **Local Proxy Validation**: Enforces mandatory reason (1–1000 characters) on revocations.
3. **Upstream Action**: `user-service` executes atomic CAS transition on `subscriptions` collection (`tier: paid` with `expires_at = now + duration`, or `tier: cancelled`), writes `ADMIN_SUBSCRIPTION_ACTIVATED` / `ADMIN_SUBSCRIPTION_REVOKED` audit log.

### 2.5 Tab 5: Support Tickets Inbox & Resolution (ADR-0023 Module B)
1. **Console Action**: Reviewer searches tickets (`GET /api/tickets`) and resolves complaint (`POST /api/tickets/resolve`, `resolution_note`).
2. **Local Proxy Validation**: Enforces mandatory resolution note (1–1000 characters).
3. **Upstream Action**: `chat-service` executes atomic CAS transition on `complaint_tickets` (`status: resolved`, `resolved_by`, `resolution_note`), atomically frees assigned support agent (`status: available`), and logs security event `ADMIN_TICKET_RESOLVED`.

---

## 3. Boundary Rules & Invariants

1. **No Admin Capabilities in Consumer Binaries**: All administrative review, suspension, dispute override, tier activation, and ticket resolution surfaces live exclusively in this repository.
2. **Internal Network Placement**: This console must remain deployed inside the private network (`saas-net`) with access to `INTERNAL_SERVICE_TOKEN`. It is never exposed directly via public gateway route rewrites.
3. **No Self-Service Admin Provisioning**: Reviewer credentials are created strictly via `cmd/onboard-reviewer` CLI; no public registration or self-service signup endpoints exist.
4. **Uniform Permission Model**: A single authenticated reviewer level governs the console; all reviewers have uniform access across all 5 modules.

