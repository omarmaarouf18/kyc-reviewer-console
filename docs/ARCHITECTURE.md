# Architecture: Review Outcome Notification Flow (End to End)

This note explains the full loop a KYB/KYE review decision travels, so a
future reader does not need both repositories side by side. Backend references
are saas-core paths at the time of ADR-0021.

## 1. Reviewer acts in this console

```
Browser ── X-Reviewer-Token ──> kyc-reviewer-console (this repo, internal net)
                                   │  injects X-Internal-Token
                                   ▼
                                auth-service  POST /auth/kyb-kye/review
                                (authenticateReviewer requires BOTH tokens)
```

auth-service validates the submission is still `pending_super_admin_approval`
(compare-and-swap update), records reviewer/attribution/reason on the user,
writes the audit entry and `KYC_REVIEWED` security event, then returns 200.
A rejection without a reason never reaches this point — it is rejected with
400 by both this console's proxy and auth-service itself.

## 2. auth-service dispatches the outcome notification

After a successful persist, auth-service fires an asynchronous goroutine to
notification-service's existing internal endpoint:

```
POST /notifications/send        (X-Internal-Token)
{
  "type":      "kyc_approved" | "kyc_rejected",
  "tenant_id": <target user's TenantID>,
  "user_id":   <target user's ID>,
  "title":     "Verification approved" | "Verification rejected",
  "body":      confirmation text | "... Reason: <reason>"
}
```

Dispatch failure is logged (`[KYC-NOTIFY]`) and swallowed: the review stays
recorded and auditable regardless. Persistence and notification are
deliberately decoupled; no retry queue exists yet (deferred in ADR-0021).

## 3. notification-service fans out

The hub broadcasts over Redis Pub/Sub (`notify:tenant:<id>`) and delivers as
an SSE `event: notification` to connected consumer-app clients of that tenant;
FCM push runs in parallel for registered device tokens. SSE delivery is
**tenant-scoped**, not user-scoped — other members of the tenant receive the
event too.

## 4. Consumer app surfaces the outcome

- The event lands normally in the notifications list/badge for everyone in
  the tenant channel.
- The Flutter app additionally gates on the payload's `user_id`
  (`NotificationModel.userId`): only the reviewed user gets an immediate
  in-app dialog (`KycRejectionDialogHost` → `InfoAlertDialog`) presenting the
  rejection reason, so they do not have to hunt for why they were rejected.
- Approvals need no new UI: the existing profile-driven status display already
  reflects "approved".

## Boundary rules (do not violate)

- No reviewer capability ever enters the consumer app binary (ADR-0013,
  enforced twice). The consumer touch above is notification *consumption*
  only.
- This console must stay inside the internal network; it is the component
  that holds `INTERNAL_SERVICE_TOKEN`. Never expose it via the public gateway,
  and never move token injection client-side.
