package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// upstreamStub asserts the two-token contract: every proxied request must
// carry BOTH X-Internal-Token (injected by this console) and
// X-Reviewer-Token (presented by the reviewer's browser).
type upstreamStub struct {
	t             *testing.T
	gotInternal   string
	gotReviewer   string
	gotPath       string
	gotBody       map[string]any
	statusCode    int
	contentType   string
	responseBytes []byte
}

func (u *upstreamStub) handler(w http.ResponseWriter, r *http.Request) {
	u.gotInternal = r.Header.Get("X-Internal-Token")
	u.gotReviewer = r.Header.Get("X-Reviewer-Token")
	u.gotPath = r.URL.Path
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		if len(b) > 0 {
			_ = json.Unmarshal(b, &u.gotBody)
		}
	}
	if u.contentType != "" {
		w.Header().Set("Content-Type", u.contentType)
	}
	w.WriteHeader(u.statusCode)
	_, _ = w.Write(u.responseBytes)
}

func newTestProxy(t *testing.T, stub *upstreamStub) (*ReviewerProxy, *httptest.Server) {
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := New("secret-internal-token", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)
	return p, upstream
}

func TestQueue_ForwardsBothTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`[{"user_id":"u1","username":"owner1"}]`)}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/queue", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-token-123")
	rec := httptest.NewRecorder()
	p.Queue(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" {
		t.Errorf("internal token not forwarded correctly: %q", stub.gotInternal)
	}
	if stub.gotReviewer != "reviewer-token-123" {
		t.Errorf("reviewer token not forwarded correctly: %q", stub.gotReviewer)
	}
	if stub.gotPath != "/auth/kyb-kye/pending" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestQueue_MissingReviewerTokenRejectedLocally(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/queue", nil)
	rec := httptest.NewRecorder()
	p.Queue(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without reviewer token, got %d", rec.Code)
	}
	if stub.gotPath != "" {
		t.Error("upstream must not be called when reviewer token is missing")
	}
}

func TestReview_ValidationsBeforeUpstream(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"reject without reason", `{"user_id":"u1","action":"reject","reason":""}`, "reason is required for rejection"},
		{"whitespace reason", `{"user_id":"u1","action":"reject","reason":"   "}`, "reason is required for rejection"},
		{"oversized reason", `{"user_id":"u1","action":"reject","reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
		{"bad action", `{"user_id":"u1","action":"maybe"}`, "approve or reject"},
		{"missing user", `{"action":"approve"}`, "user_id is required"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			p, _ := newTestProxy(t, stub)

			req := httptest.NewRequest(http.MethodPost, "/api/review", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.Review(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid review payloads must never reach auth-service")
			}
		})
	}
}

func TestReview_RejectWithReasonForwarded(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"status":"reviewed","action":"reject"}`)}
	p, _ := newTestProxy(t, stub)

	body := `{"user_id":"u1","action":"reject","reason":"blurry document"}`
	req := httptest.NewRequest(http.MethodPost, "/api/review", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Review(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotBody["action"] != "reject" || stub.gotBody["reason"] != "blurry document" {
		t.Errorf("payload mismatch at upstream: %+v", stub.gotBody)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "tok" {
		t.Errorf("token contract violated: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
}

func TestDocumentView_StreamsBytesThroughProxy(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		contentType:   "image/jpeg",
		responseBytes: []byte{0xFF, 0xD8, 0xFF, 0xE0}}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/documents/view?token=signed-view-jwt", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.DocumentView(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Errorf("content type not relayed: %q", got)
	}
	if rec.Body.Len() != 4 || rec.Body.Bytes()[0] != 0xFF {
		t.Errorf("document bytes not streamed intact: %v", rec.Body.Bytes())
	}
	if !strings.Contains(stub.gotPath, "/auth/documents/view") {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestDocumentView_MissingTokenRejected(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/documents/view", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.DocumentView(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing view token, got %d", rec.Code)
	}
	if stub.gotPath != "" {
		t.Error("upstream must not be called when view token is missing")
	}
}

func TestAccounts_ForwardsQueryAndTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"accounts":[{"id":"u1","username":"alice"}],"total":1,"page":1,"limit":20}`)}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/accounts?search=alice&role=owner&page=1&limit=10", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-123")
	rec := httptest.NewRecorder()
	p.Accounts(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-123" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/auth/accounts" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestAccounts_MissingTokenRejectedLocally(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	p, _ := newTestProxy(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	rec := httptest.NewRecorder()
	p.Accounts(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without reviewer token, got %d", rec.Code)
	}
	if stub.gotPath != "" {
		t.Error("upstream must not be called when reviewer token is missing")
	}
}

func TestSuspend_ValidationsBeforeUpstream(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"missing user_id", `{"reason":"Fraud"}`, "user_id is required"},
		{"missing reason", `{"user_id":"u1","reason":""}`, "reason is required for suspension"},
		{"whitespace reason", `{"user_id":"u1","reason":"   "}`, "reason is required for suspension"},
		{"oversized reason", `{"user_id":"u1","reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			p, _ := newTestProxy(t, stub)

			req := httptest.NewRequest(http.MethodPost, "/api/accounts/suspend", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.Suspend(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid suspend payload must not reach auth-service")
			}
		})
	}
}

func TestSuspend_ValidPayloadForwarded(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"status":"suspended","user_id":"u1","account_status":"suspended"}`)}
	p, _ := newTestProxy(t, stub)

	body := `{"user_id":"u1","reason":"Policy violation"}`
	req := httptest.NewRequest(http.MethodPost, "/api/accounts/suspend", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Suspend(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotBody["user_id"] != "u1" || stub.gotBody["reason"] != "Policy violation" {
		t.Errorf("payload mismatch: %+v", stub.gotBody)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "tok" {
		t.Errorf("token mismatch: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
}

func TestReactivate_ValidPayloadForwarded(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"status":"reactivated","user_id":"u1","account_status":"active"}`)}
	p, _ := newTestProxy(t, stub)

	body := `{"user_id":"u1","reason":"Appeal accepted"}`
	req := httptest.NewRequest(http.MethodPost, "/api/accounts/reactivate", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Reactivate(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotBody["user_id"] != "u1" || stub.gotBody["reason"] != "Appeal accepted" {
		t.Errorf("payload mismatch: %+v", stub.gotBody)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "tok" {
		t.Errorf("token mismatch: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
}

func TestReconciliationQueue_ForwardsToUserServiceWithTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"disputes":[{"id":"job-123","booked_distance":10.0,"actual_distance":5.0}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/reconciliation/queue?page=1&limit=15", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.ReconciliationQueue(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/admin/reconciliation/queue" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestResolveReconciliation_ValidationsBeforeUpstream(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"missing job_id", `{"decision":"release_to_employee","reason":"valid"}`, "job_id is required"},
		{"invalid decision", `{"job_id":"j1","decision":"invalid","reason":"valid"}`, "decision must be release_to_employee or refund_to_customer"},
		{"missing reason", `{"job_id":"j1","decision":"refund_to_customer","reason":""}`, "reason is required for dispute resolution"},
		{"whitespace reason", `{"job_id":"j1","decision":"refund_to_customer","reason":"   "}`, "reason is required for dispute resolution"},
		{"oversized reason", `{"job_id":"j1","decision":"refund_to_customer","reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/reconciliation/resolve", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.ResolveReconciliation(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid resolve payload must never reach user-service")
			}
		})
	}
}

func TestResolveReconciliation_ValidPayloadForwarded(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"message":"dispute resolved successfully","job_id":"j1","status":"completed","decision":"release_to_employee"}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	body := `{"job_id":"j1","decision":"release_to_employee","reason":"GPS anomaly investigated; delivery verified"}`
	req := httptest.NewRequest(http.MethodPost, "/api/reconciliation/resolve", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "tok-xyz")
	rec := httptest.NewRecorder()
	p.ResolveReconciliation(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotBody["job_id"] != "j1" || stub.gotBody["decision"] != "release_to_employee" {
		t.Errorf("payload mismatch at upstream: %+v", stub.gotBody)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "tok-xyz" {
		t.Errorf("tokens mismatch: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/admin/reconciliation/resolve" {
		t.Errorf("unexpected path: %q", stub.gotPath)
	}
}

func TestSubscriptions_ForwardsToUserServiceWithTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"subscriptions":[{"id":"sub-1","tenant_id":"t1","tier":"pending_payment"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/subscriptions?status=pending_payment&page=1&limit=15", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-sub")
	rec := httptest.NewRecorder()
	p.Subscriptions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-sub" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/admin/subscriptions" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestActivateSubscription_ForwardsToUserService(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"message":"subscription activated successfully","subscription":{"id":"sub-1","tenant_id":"t1","tier":"paid"}}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
	t.Cleanup(upstream.Close)

	body := `{"tenant_id":"t1","duration_days":60}`
	req := httptest.NewRequest(http.MethodPost, "/api/subscriptions/activate", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-sub")
	rec := httptest.NewRecorder()
	p.ActivateSubscription(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotBody["tenant_id"] != "t1" {
		t.Errorf("unexpected body at upstream: %+v", stub.gotBody)
	}
	if stub.gotPath != "/admin/subscriptions/activate" {
		t.Errorf("unexpected path: %q", stub.gotPath)
	}
}

func TestRevokeSubscription_ValidationsAndForwarding(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"missing tenant_id", `{"reason":"valid reason"}`, "tenant_id or subscription_id is required"},
		{"missing reason", `{"tenant_id":"t1","reason":""}`, "reason is required for revocation"},
		{"whitespace reason", `{"tenant_id":"t1","reason":"   "}`, "reason is required for revocation"},
		{"oversized reason", `{"tenant_id":"t1","reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/subscriptions/revoke", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.RevokeSubscription(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid revoke payload must never reach upstream")
			}
		})
	}

	t.Run("Valid Revoke Forwarded", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"message":"subscription revoked successfully"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"tenant_id":"t1","reason":"Non-payment of invoice"}`
		req := httptest.NewRequest(http.MethodPost, "/api/subscriptions/revoke", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.RevokeSubscription(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotBody["reason"] != "Non-payment of invoice" {
			t.Errorf("reason not forwarded: %+v", stub.gotBody)
		}
	})
}

func TestTickets_ForwardsToChatServiceWithTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"tickets":[{"ticket_id":"tkt-1","customer_id":"c1","status":"pending"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/tickets?status=pending&page=1&limit=15", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-ticket")
	rec := httptest.NewRecorder()
	p.Tickets(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-ticket" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/admin/tickets" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestResolveTicket_ValidationsAndForwarding(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"missing ticket_id", `{"resolution_note":"valid note"}`, "ticket_id is required"},
		{"missing resolution_note", `{"ticket_id":"tkt-1","resolution_note":""}`, "resolution_note is required"},
		{"whitespace resolution_note", `{"ticket_id":"tkt-1","resolution_note":"   "}`, "resolution_note is required"},
		{"oversized resolution_note", `{"ticket_id":"tkt-1","resolution_note":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/tickets/resolve", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.ResolveTicket(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid resolve payload must never reach upstream")
			}
		})
	}

	t.Run("Valid Resolve Ticket Forwarded", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"message":"ticket resolved successfully"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"ticket_id":"tkt-100","resolution_note":"Resolved by courier follow-up"}`
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/resolve", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok-resolved")
		rec := httptest.NewRecorder()
		p.ResolveTicket(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotBody["resolution_note"] != "Resolved by courier follow-up" || stub.gotBody["ticket_id"] != "tkt-100" {
			t.Errorf("payload mismatch: %+v", stub.gotBody)
		}
		if stub.gotPath != "/admin/tickets/resolve" {
			t.Errorf("unexpected path: %q", stub.gotPath)
		}
	})
}
