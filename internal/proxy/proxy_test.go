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
	t              *testing.T
	gotInternal    string
	gotReviewer    string
	gotPath        string
	gotRawQuery    string
	gotContentType string
	gotHeaders     map[string]string
	gotBody        map[string]any
	statusCode     int
	contentType    string
	responseBytes  []byte
}

func (u *upstreamStub) handler(w http.ResponseWriter, r *http.Request) {
	u.gotInternal = r.Header.Get("X-Internal-Token")
	u.gotReviewer = r.Header.Get("X-Reviewer-Token")
	u.gotPath = r.URL.Path
	u.gotRawQuery = r.URL.RawQuery
	u.gotContentType = r.Header.Get("Content-Type")
	u.gotHeaders = make(map[string]string)
	for k, vv := range r.Header {
		if len(vv) > 0 {
			u.gotHeaders[k] = vv[0]
		}
	}
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

func TestAudit_ForwardsToAuthServiceWithQuery(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"entries":[{"id":"a1","source":"user-service","action":"job.cancel"}],"total":1,"page":1,"limit":20,"sources":{"auth-service":"ok"}}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := New("secret-internal-token", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/audit?action=job.cancel&page=1&limit=20", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.Audit(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotPath != "/admin/audit" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
	if stub.gotRawQuery != "action=job.cancel&page=1&limit=20" {
		t.Errorf("query not forwarded: %q", stub.gotRawQuery)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
}

func TestAudit_RejectsNonGET(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := New("secret-internal-token", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodPost, "/api/audit", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	p.Audit(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/audit = %d, want 405", rec.Code)
	}
	if stub.gotPath != "" {
		t.Errorf("the upstream must not be reached: %q", stub.gotPath)
	}
}

func TestVersion_GetReachesTheGatewayOverTheInternalURL(t *testing.T) {
	gateway := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"id":"global","latest_version":"1.5.2","minimum_supported_version":"1.4.0"}`)}
	auth := &upstreamStub{t: t, statusCode: http.StatusOK}
	authServer := httptest.NewServer(http.HandlerFunc(auth.handler))
	gatewayServer := httptest.NewServer(http.HandlerFunc(gateway.handler))
	t.Cleanup(authServer.Close)
	t.Cleanup(gatewayServer.Close)

	p := NewWithAllServices("secret-internal-token", authServer.URL, authServer.URL, authServer.URL, authServer.URL, gatewayServer.URL, authServer.Client())

	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.Version(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if gateway.gotPath != "/admin/version" {
		t.Errorf("unexpected gateway path: %q", gateway.gotPath)
	}
	if gateway.gotInternal != "secret-internal-token" || gateway.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded to the gateway: internal=%q reviewer=%q", gateway.gotInternal, gateway.gotReviewer)
	}
	if auth.gotPath != "" {
		t.Errorf("the version call must not hit auth-service: %q", auth.gotPath)
	}
}

func TestVersion_UpdateValidatesTheReasonBeforeTheGateway(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"missing reason", `{"latest_version":"1.5.2"}`, "reason is required"},
		{"blank reason", `{"reason":"   "}`, "reason is required"},
		{"oversized reason", `{"reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
		{"invalid json", `not-json`, "invalid JSON body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := &upstreamStub{t: t, statusCode: http.StatusOK}
			gatewayServer := httptest.NewServer(http.HandlerFunc(gateway.handler))
			t.Cleanup(gatewayServer.Close)
			p := NewWithAllServices("secret-internal-token", gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.Client())

			req := httptest.NewRequest(http.MethodPut, "/api/version", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.Version(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("PUT /api/version = %d, want 400", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("body %q missing %q", rec.Body.String(), tc.want)
			}
			if gateway.gotPath != "" {
				t.Errorf("an invalid update must not reach the gateway (saw %q)", gateway.gotPath)
			}
		})
	}
}

func TestVersion_UpdateForwardsEveryPolicyField(t *testing.T) {
	gateway := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{"message":"version configuration updated successfully"}`)}
	gatewayServer := httptest.NewServer(http.HandlerFunc(gateway.handler))
	t.Cleanup(gatewayServer.Close)
	p := NewWithAllServices("secret-internal-token", gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.URL, gatewayServer.Client())

	body := `{"minimum_supported_version":"1.5.0","latest_version":"1.5.2","download_url":"https://play.google.com/store/apps/details?id=tech.logiclinkeg.app","reason":"Deprecating API v1 endpoints"}`
	req := httptest.NewRequest(http.MethodPut, "/api/version", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Version(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if gateway.gotPath != "/admin/version" {
		t.Errorf("unexpected gateway path: %q", gateway.gotPath)
	}
	if gateway.gotBody["reason"] != "Deprecating API v1 endpoints" {
		t.Errorf("reason not forwarded: %+v", gateway.gotBody)
	}
	if gateway.gotBody["latest_version"] != "1.5.2" || gateway.gotBody["minimum_supported_version"] != "1.5.0" {
		t.Errorf("policy fields not forwarded: %+v", gateway.gotBody)
	}
	if gateway.gotBody["download_url"] != "https://play.google.com/store/apps/details?id=tech.logiclinkeg.app" {
		t.Errorf("download_url not forwarded: %+v", gateway.gotBody)
	}
}

func TestNotificationSend_ForwardsToNotificationService(t *testing.T) {
	notif := &upstreamStub{t: t, statusCode: http.StatusAccepted,
		responseBytes: []byte(`{"job_id":"send-1793255745373574323","status":"queued","audience_size":450,"message":"admin notification queued for delivery"}`)}
	upstream := httptest.NewServer(http.HandlerFunc(notif.handler))
	t.Cleanup(upstream.Close)
	p := NewWithAllServices("secret-internal-token", upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.Client())

	body := `{"reason":"Emergency platform maintenance notification","audience":{"kind":"role","role":"customers"},"title":{"en":"Scheduled System Maintenance","ar":"صيانة مجدولة"},"body":{"en":"Maintenance tonight","ar":"صيانة الليلة"},"deep_link":"/plan","dry_run":false,"confirm_audience_size":0,"test_user_id":"","idempotency_key":"announce-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/notifications/send", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.NotificationSend(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	if notif.gotPath != "/admin/notifications/send" {
		t.Errorf("unexpected upstream path: %q", notif.gotPath)
	}
	if notif.gotInternal != "secret-internal-token" || notif.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded: internal=%q reviewer=%q", notif.gotInternal, notif.gotReviewer)
	}
	if notif.gotBody["reason"] != "Emergency platform maintenance notification" {
		t.Errorf("reason not forwarded: %+v", notif.gotBody)
	}
	if notif.gotBody["idempotency_key"] != "announce-1" {
		t.Errorf("idempotency key not forwarded: %+v", notif.gotBody)
	}
	if notif.gotBody["deep_link"] != "/plan" {
		t.Errorf("deep link not forwarded: %+v", notif.gotBody)
	}
}

func TestNotificationSend_ValidatesBeforeTheService(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"missing reason", `{"audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_reason"},
		{"oversized reason", `{"reason":"` + strings.Repeat("x", 1001) + `","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_reason"},
		{"missing english title", `{"reason":"r","audience":{"kind":"everyone"},"title":{"ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_title"},
		{"missing arabic title", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t"},"body":{"en":"b","ar":"ب"}}`, "invalid_title"},
		{"oversized title", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"` + strings.Repeat("x", 121) + `","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_title"},
		{"missing english body", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"ar":"ب"}}`, "invalid_body"},
		{"missing arabic body", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b"}}`, "invalid_body"},
		{"external deep link", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"},"deep_link":"https://evil.example.com"}`, "invalid_deep_link"},
		{"scheme deep link", `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"},"deep_link":"javascript:alert(1)"}`, "invalid_deep_link"},
		{"unknown audience", `{"reason":"r","audience":{"kind":"aliens"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_audience"},
		{"user without identifier", `{"reason":"r","audience":{"kind":"user"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_audience"},
		{"role without role", `{"reason":"r","audience":{"kind":"role"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_audience"},
		{"tenant without tenant", `{"reason":"r","audience":{"kind":"tenant"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"}}`, "invalid_audience"},
		{"invalid json", `not-json`, "invalid JSON body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			notif := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(notif.handler))
			t.Cleanup(upstream.Close)
			p := NewWithAllServices("secret-internal-token", upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.Client())

			req := httptest.NewRequest(http.MethodPost, "/api/notifications/send", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.NotificationSend(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("POST /api/notifications/send = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("body %q missing %q", rec.Body.String(), tc.want)
			}
			if notif.gotPath != "" {
				t.Errorf("an invalid announcement must not reach the service (saw %q)", notif.gotPath)
			}
		})
	}
}

func TestNotificationSend_AcceptsTheAllowedDeepLinks(t *testing.T) {
	for _, link := range []string{"/plan", "/plans", "/subscriptions", "/verification", "/kyc", "/tickets/tkt-1", "/orders/ord-9", "/jobs/job-9"} {
		notif := &upstreamStub{t: t, statusCode: http.StatusAccepted, responseBytes: []byte(`{}`)}
		upstream := httptest.NewServer(http.HandlerFunc(notif.handler))
		p := NewWithAllServices("secret-internal-token", upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.Client())

		body := `{"reason":"r","audience":{"kind":"everyone"},"title":{"en":"t","ar":"ع"},"body":{"en":"b","ar":"ب"},"deep_link":"` + link + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/notifications/send", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.NotificationSend(rec, req)
		upstream.Close()

		if rec.Code != http.StatusAccepted {
			t.Errorf("deep link %q = %d, want 202: %s", link, rec.Code, rec.Body.String())
		}
	}
}

func TestNotificationSends_ListAndDetail(t *testing.T) {
	notif := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"sends":[{"id":"send-1","audience_size":450,"status":"done"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(notif.handler))
	t.Cleanup(upstream.Close)
	p := NewWithAllServices("secret-internal-token", upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.Client())

	req := httptest.NewRequest(http.MethodGet, "/api/notifications/sends?page=1&limit=20", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.NotificationSends(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if notif.gotPath != "/admin/notifications/sends" {
		t.Errorf("unexpected upstream path: %q", notif.gotPath)
	}
	if notif.gotRawQuery != "page=1&limit=20" {
		t.Errorf("query not forwarded: %q", notif.gotRawQuery)
	}

	notif.gotPath = ""
	req = httptest.NewRequest(http.MethodGet, "/api/notifications/sends/send-1793255745373574323", nil)
	req.SetPathValue("id", "send-1793255745373574323")
	req.Header.Set("X-Reviewer-Token", "tok")
	rec = httptest.NewRecorder()
	p.NotificationSendDetail(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if notif.gotPath != "/admin/notifications/sends/send-1793255745373574323" {
		t.Errorf("unexpected upstream path: %q", notif.gotPath)
	}
}

// TestConsoleClientIP_ForwardsTheEdgeClientIP checks the reviewer rate-limit
// contract: the console sends the reviewer's browser IP (the edge-set
// X-Forwarded-For) as X-Console-Client-IP and never forwards the browser's
// forwarding headers.
func TestConsoleClientIP_ForwardsTheEdgeClientIP(t *testing.T) {
	for _, tc := range []struct {
		name string
		xff  string
		want string
	}{
		{"single address", "203.0.113.10", "203.0.113.10"},
		{"chain uses the client address", "203.0.113.10, 198.51.100.7", "203.0.113.10"},
		{"chain with spaces", "203.0.113.10 , 198.51.100.7", "203.0.113.10"},
		{"ipv6", "2001:db8::1", "2001:db8::1"},
		{"ipv6 with a port", "[2001:db8::1]:443", "2001:db8::1"},
		{"ipv4 with a port", "203.0.113.10:443", "203.0.113.10"},
		{"not an ip", "unknown", ""},
		{"empty", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{}`)}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			t.Cleanup(upstream.Close)
			p := New("secret-internal-token", upstream.URL, upstream.Client())

			req := httptest.NewRequest(http.MethodGet, "/api/queue", nil)
			req.Header.Set("X-Reviewer-Token", "tok")
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			// A browser may send these; they must never reach the service.
			req.Header.Set("X-Real-IP", "198.51.100.7")
			rec := httptest.NewRecorder()
			p.Queue(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			// Go canonicalizes the header key ("...-Ip"); the wire format is
			// case-insensitive, so the service still reads it.
			if got := stub.gotHeaders[http.CanonicalHeaderKey("X-Console-Client-IP")]; got != tc.want {
				t.Errorf("X-Console-Client-IP = %q, want %q", got, tc.want)
			}
			if _, ok := stub.gotHeaders["X-Forwarded-For"]; ok {
				t.Error("X-Forwarded-For must not be forwarded upstream")
			}
			if _, ok := stub.gotHeaders["X-Real-IP"]; ok {
				t.Error("X-Real-IP must not be forwarded upstream")
			}
		})
	}
}

// TestConsoleClientIP_ReachesEveryService checks that the reviewer IP is
// attached to the calls of every service (they all verify the reviewer
// against auth-service, whose per-IP limit keys on this header).
func TestConsoleClientIP_ReachesEveryService(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	t.Cleanup(upstream.Close)
	p := NewWithAllServices("secret-internal-token", upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.URL, upstream.Client())

	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	req.Header.Set("X-Forwarded-For", "203.0.113.10")
	rec := httptest.NewRecorder()
	p.Version(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := stub.gotHeaders[http.CanonicalHeaderKey("X-Console-Client-IP")]; got != "203.0.113.10" {
		t.Errorf("X-Console-Client-IP = %q, want 203.0.113.10", got)
	}
}

func TestSubscriptionQueue_ForwardsToUserService(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"queue":[{"id":"sub-771","tenant_id":"tenant-cairo-express","requested_plan":"pro"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/subscriptions/queue?page=1&limit=20", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.SubscriptionQueue(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotPath != "/admin/subscriptions/queue" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
	if stub.gotRawQuery != "page=1&limit=20" {
		t.Errorf("query not forwarded: %q", stub.gotRawQuery)
	}
}

func TestServices_ForwardsToUserServiceWithQuery(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"services":[{"id":"svc-555","is_hidden":true}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/services?hidden=true&page=1", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Services(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotPath != "/admin/services" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
	if stub.gotRawQuery != "hidden=true&page=1" {
		t.Errorf("query not forwarded: %q", stub.gotRawQuery)
	}
}

func TestServiceActions_ForwardReasonAndPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(p *ReviewerProxy, w http.ResponseWriter, r *http.Request)
		path string
	}{
		{"hide", (*ReviewerProxy).HideService, "/admin/services/svc-555/hide"},
		{"unhide", (*ReviewerProxy).UnhideService, "/admin/services/svc-555/unhide"},
		{"photo remove", (*ReviewerProxy).RemoveServicePhoto, "/admin/services/svc-555/photo/remove"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{"success":true}`)}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/services/svc-555", strings.NewReader(`{"reason":"policy violation"}`))
			req.SetPathValue("id", "svc-555")
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			tc.call(p, rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			if stub.gotPath != tc.path {
				t.Errorf("unexpected upstream path: %q", stub.gotPath)
			}
			if stub.gotBody["reason"] != "policy violation" {
				t.Errorf("reason not forwarded: %+v", stub.gotBody)
			}
		})
	}
}

func TestServiceActions_ValidateReasonBeforeUpstream(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodPost, "/api/services/svc-555/hide", strings.NewReader(`{"reason":"   "}`))
	req.SetPathValue("id", "svc-555")
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.HideService(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("blank reason = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "reason is required") {
		t.Errorf("unexpected error body: %s", rec.Body.String())
	}
	if stub.gotPath != "" {
		t.Errorf("invalid request must not reach the upstream (saw %q)", stub.gotPath)
	}
}

func TestJobs_ForwardsToUserServiceWithQuery(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"jobs":[{"id":"job-98712","status":"active"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/jobs?status=active&page=2", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.Jobs(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotPath != "/admin/jobs" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
	if stub.gotRawQuery != "status=active&page=2" {
		t.Errorf("query not forwarded: %q", stub.gotRawQuery)
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
}

func TestJobDetail_ForwardsEscapedJobID(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{"id":"job-1"}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job-1", nil)
	req.SetPathValue("id", "job-1")
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.JobDetail(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotPath != "/admin/jobs/job-1" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestJobDetail_RejectsEmptyID(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/", nil)
	req.SetPathValue("id", "  ")
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.JobDetail(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty job id = %d, want 400", rec.Code)
	}
	if stub.gotPath != "" {
		t.Errorf("empty job id must not reach the upstream (saw %q)", stub.gotPath)
	}
}

func TestJobMutations_ValidateReasonBeforeUpstream(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"missing reason", `{}`, "reason is required"},
		{"blank reason", `{"reason":"   "}`, "reason is required"},
		{"oversized reason", `{"reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/jobs/job-1/cancel", strings.NewReader(tc.body))
			req.SetPathValue("id", "job-1")
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.CancelJob(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("cancel = %d, want 400", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("cancel body %q missing %q", rec.Body.String(), tc.want)
			}
			if stub.gotPath != "" {
				t.Errorf("invalid request must not reach the upstream (saw %q)", stub.gotPath)
			}
		})
	}
}

func TestJobMutations_ForwardReasonAndPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(p *ReviewerProxy, w http.ResponseWriter, r *http.Request)
		path string
	}{
		{"cancel", (*ReviewerProxy).CancelJob, "/admin/jobs/job-42/cancel"},
		{"complete stuck cod", (*ReviewerProxy).CompleteStuckCOD, "/admin/jobs/job-42/complete-stuck-cod"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK, responseBytes: []byte(`{"success":true}`)}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/jobs/job-42", strings.NewReader(`{"reason":"customer requested"}`))
			req.SetPathValue("id", "job-42")
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			tc.call(p, rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			if stub.gotPath != tc.path {
				t.Errorf("unexpected upstream path: %q", stub.gotPath)
			}
			if stub.gotBody["reason"] != "customer requested" {
				t.Errorf("reason not forwarded: %+v", stub.gotBody)
			}
		})
	}
}

func TestOverview_ForwardsToUserServiceWithTokens(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"pending_kyb_kye":14,"pending_payment_subscriptions":3,"open_tickets":5,"assigned_tickets":2,"gps_disputes":2,"stuck_cod_jobs":1,"jobs_today":{"pending_dispatch":5,"active":12,"completed":45,"cancelled":2},"new_accounts_today":18,"new_accounts_7d":114,"suspended_accounts":"unavailable"}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/overview", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-tok-abc")
	rec := httptest.NewRecorder()
	p.Overview(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-abc" {
		t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/admin/overview" {
		t.Errorf("unexpected upstream path: %q", stub.gotPath)
	}
}

func TestOverview_MethodGating(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithUserService("secret-internal-token", "https://auth-service", upstream.URL, upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodPost, "/api/overview", nil)
	req.Header.Set("X-Reviewer-Token", "tok")
	rec := httptest.NewRecorder()
	p.Overview(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/overview = %d, want 405", rec.Code)
	}
	if stub.gotPath != "" {
		t.Errorf("POST must not reach the upstream (saw %q)", stub.gotPath)
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

	t.Run("Upstream 503 Service Unavailable Relayed As 503", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusServiceUnavailable,
			responseBytes: []byte(`{"error":"service_unavailable","message":"Authentication service is temporarily unavailable."}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"ticket_id":"tkt-100","resolution_note":"Resolved note"}`
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/resolve", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok-resolved")
		rec := httptest.NewRecorder()
		p.ResolveTicket(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d: %s", rec.Code, rec.Body.String())
		}
		if rec.Code == http.StatusUnauthorized {
			t.Fatal("upstream 503 must NEVER be converted into 401 Unauthorized")
		}
	})

	t.Run("Upstream 401 Unauthorized Relayed As 401", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusUnauthorized,
			responseBytes: []byte(`{"error":"unauthorized"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"ticket_id":"tkt-100","resolution_note":"Resolved note"}`
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/resolve", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok-resolved")
		rec := httptest.NewRecorder()
		p.ResolveTicket(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestMe_ForwardsToAuthService(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"id":"rev-123","name":"Test Reviewer"}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithServices("secret-internal-token", upstream.URL, "https://user-service", "https://chat-service", upstream.Client())
	t.Cleanup(upstream.Close)

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set("X-Reviewer-Token", "reviewer-token-abc")
	rec := httptest.NewRecorder()
	p.Me(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-token-abc" {
		t.Errorf("tokens mismatch: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
	}
	if stub.gotPath != "/auth/reviewer/verify" {
		t.Errorf("unexpected path: %q", stub.gotPath)
	}
}

func TestAcceptTicket_ValidationsAndForwarding(t *testing.T) {
	t.Run("missing ticket_id", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		req := httptest.NewRequest(http.MethodPost, "/api/tickets/accept", strings.NewReader(`{"ticket_id":""}`))
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.AcceptTicket(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "ticket_id is required") {
			t.Errorf("expected error containing 'ticket_id is required', got %s", rec.Body.String())
		}
	})

	t.Run("valid accept forwarded", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"message":"ticket accepted successfully","ticket":{"ticket_id":"tkt-200","status":"assigned"}}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"ticket_id":"tkt-200"}`
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/accept", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok-accept")
		rec := httptest.NewRecorder()
		p.AcceptTicket(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotBody["ticket_id"] != "tkt-200" {
			t.Errorf("ticket_id mismatch: %+v", stub.gotBody)
		}
		if stub.gotPath != "/admin/tickets/accept" {
			t.Errorf("unexpected path: %q", stub.gotPath)
		}
	})
}

func TestPayouts_ForwardsToUserService(t *testing.T) {
	stub := &upstreamStub{t: t, statusCode: http.StatusOK,
		responseBytes: []byte(`{"payouts":[{"id":"po-1","amount":100,"status":"requested"}],"total":1,"page":1,"limit":20}`)}
	upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
	p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
	t.Cleanup(upstream.Close)

	t.Run("missing reviewer token rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/payouts", nil)
		rec := httptest.NewRecorder()
		p.Payouts(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 without reviewer token, got %d", rec.Code)
		}
	})

	t.Run("wrong method rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/payouts", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.Payouts(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("valid get forwarded with query params", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/payouts?status=requested&page=1&limit=20", nil)
		req.Header.Set("X-Reviewer-Token", "reviewer-tok-payout")
		rec := httptest.NewRecorder()
		p.Payouts(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotInternal != "secret-internal-token" || stub.gotReviewer != "reviewer-tok-payout" {
			t.Errorf("tokens not forwarded correctly: internal=%q reviewer=%q", stub.gotInternal, stub.gotReviewer)
		}
		if stub.gotPath != "/admin/payouts" {
			t.Errorf("unexpected upstream path: %q", stub.gotPath)
		}
	})
}

func TestRejectPayout_ValidationsAndForwarding(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{"missing payout_id", `{"reason":"invalid account"}`, "payout_id is required"},
		{"missing reason", `{"payout_id":"po-1","reason":""}`, "reason is required"},
		{"whitespace reason", `{"payout_id":"po-1","reason":"   "}`, "reason is required"},
		{"oversized reason", `{"payout_id":"po-1","reason":"` + strings.Repeat("x", 1001) + `"}`, "1000 characters"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &upstreamStub{t: t, statusCode: http.StatusOK}
			upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
			p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
			t.Cleanup(upstream.Close)

			req := httptest.NewRequest(http.MethodPost, "/api/payouts/reject", strings.NewReader(tc.body))
			req.Header.Set("X-Reviewer-Token", "tok")
			rec := httptest.NewRecorder()
			p.RejectPayout(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSub) {
				t.Errorf("expected error containing %q, got %s", tc.wantSub, rec.Body.String())
			}
			if stub.gotPath != "" {
				t.Error("invalid reject payload must never reach upstream")
			}
		})
	}

	t.Run("wrong method rejected", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
		t.Cleanup(upstream.Close)

		req := httptest.NewRequest(http.MethodGet, "/api/payouts/reject", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.RejectPayout(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("valid reject forwarded to user-service", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"message":"payout request rejected","payout_id":"po-100"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal-token", "https://auth-service", upstream.URL, "https://chat-service", upstream.Client())
		t.Cleanup(upstream.Close)

		body := `{"payout_id":"po-100","reason":"Invalid IBAN details provided"}`
		req := httptest.NewRequest(http.MethodPost, "/api/payouts/reject", strings.NewReader(body))
		req.Header.Set("X-Reviewer-Token", "tok-reject-payout")
		rec := httptest.NewRecorder()
		p.RejectPayout(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotBody["payout_id"] != "po-100" || stub.gotBody["reason"] != "Invalid IBAN details provided" {
			t.Errorf("payload mismatch: %+v", stub.gotBody)
		}
		if stub.gotPath != "/admin/payouts/reject" {
			t.Errorf("unexpected path: %q", stub.gotPath)
		}
	})
}

func TestUserDocuments_ValidationsAndForwarding(t *testing.T) {
	t.Run("wrong method rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodPost, "/api/documents/user", nil)
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("missing reviewer token rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/documents/user?user_id=u1&reason=audit", nil)
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rec.Code)
		}
	})

	t.Run("missing user identifier rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/documents/user?reason=audit", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("missing reason rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/documents/user?user_id=u1", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("oversized reason rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/documents/user?user_id=u1&reason="+strings.Repeat("r", 1001), nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("valid request forwarded to auth-service", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"user_id":"u-100","id_front_url":"https://view"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal", upstream.URL, "https://user-service", "https://chat-service", upstream.Client())
		t.Cleanup(upstream.Close)

		req := httptest.NewRequest(http.MethodGet, "/api/documents/user?user_id=u-100&reason=audit-check", nil)
		req.Header.Set("X-Reviewer-Token", "tok-user-docs")
		rec := httptest.NewRecorder()
		p.UserDocuments(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if !strings.HasPrefix(stub.gotPath, "/auth/reviewer/user-documents") {
			t.Errorf("unexpected path: %q", stub.gotPath)
		}
		if stub.gotHeaders["X-Internal-Token"] != "secret-internal" {
			t.Errorf("missing internal token: %v", stub.gotHeaders)
		}
		if stub.gotHeaders["X-Reviewer-Token"] != "tok-user-docs" {
			t.Errorf("missing reviewer token: %v", stub.gotHeaders)
		}
	})
}

func TestTicketAttachment_ValidationsAndForwarding(t *testing.T) {
	t.Run("wrong method rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/tickets/attachment?ticket_id=tkt-1", nil)
		rec := httptest.NewRecorder()
		p.TicketAttachment(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("missing reviewer token rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/attachment?ticket_id=tkt-1", strings.NewReader("data"))
		rec := httptest.NewRecorder()
		p.TicketAttachment(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rec.Code)
		}
	})

	t.Run("missing ticket_id rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/attachment", strings.NewReader("data"))
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.TicketAttachment(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("valid attachment upload forwarded to chat-service", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte(`{"status":"success","attachment_url":"https://view"}`)}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		req := httptest.NewRequest(http.MethodPost, "/api/tickets/attachment?ticket_id=tkt-999", strings.NewReader("dummy-multipart-content"))
		req.Header.Set("Content-Type", "multipart/form-data; boundary=---boundary123")
		req.Header.Set("X-Reviewer-Token", "tok-attach")
		rec := httptest.NewRecorder()
		p.TicketAttachment(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotPath != "/chat/tickets/tkt-999/attachment" {
			t.Errorf("unexpected upstream path: %q", stub.gotPath)
		}
		if stub.gotHeaders["Content-Type"] != "multipart/form-data; boundary=---boundary123" {
			t.Errorf("expected Content-Type preserved, got %q", stub.gotHeaders["Content-Type"])
		}
		if stub.gotHeaders["X-Internal-Token"] != "secret-internal" {
			t.Errorf("missing internal token")
		}
	})
}

func TestAttachmentView_ValidationsAndForwarding(t *testing.T) {
	t.Run("wrong method rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodPost, "/api/chat/attachments/view?token=tok", nil)
		rec := httptest.NewRecorder()
		p.AttachmentView(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rec.Code)
		}
	})

	t.Run("missing reviewer token rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/chat/attachments/view?token=tok", nil)
		rec := httptest.NewRecorder()
		p.AttachmentView(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rec.Code)
		}
	})

	t.Run("missing token param rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/chat/attachments/view", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.AttachmentView(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("dangerous token chars rejected", func(t *testing.T) {
		p := NewWithServices("secret", "https://auth-service", "https://user-service", "https://chat-service", http.DefaultClient)
		req := httptest.NewRequest(http.MethodGet, "/api/chat/attachments/view?token=bad/token", nil)
		req.Header.Set("X-Reviewer-Token", "tok")
		rec := httptest.NewRecorder()
		p.AttachmentView(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("valid view forwarded to chat-service", func(t *testing.T) {
		stub := &upstreamStub{t: t, statusCode: http.StatusOK,
			responseBytes: []byte("image-binary-data")}
		upstream := httptest.NewServer(http.HandlerFunc(stub.handler))
		p := NewWithServices("secret-internal", "https://auth-service", "https://user-service", upstream.URL, upstream.Client())
		t.Cleanup(upstream.Close)

		req := httptest.NewRequest(http.MethodGet, "/api/chat/attachments/view?token=valid-jwt-view-token", nil)
		req.Header.Set("X-Reviewer-Token", "tok-view")
		rec := httptest.NewRecorder()
		p.AttachmentView(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if stub.gotPath != "/chat/attachments/view" || stub.gotRawQuery != "token=valid-jwt-view-token" {
			t.Errorf("unexpected path or query: path=%q query=%q", stub.gotPath, stub.gotRawQuery)
		}
		if rec.Body.String() != "image-binary-data" {
			t.Errorf("body mismatch: %s", rec.Body.String())
		}
	})
}
