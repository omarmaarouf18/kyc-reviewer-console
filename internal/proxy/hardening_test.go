package proxy

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func runtimeName(f any) string {
	return runtime.FuncForPC(reflect.ValueOf(f).Pointer()).Name()
}

func newHardeningProxy(t *testing.T, upstream http.HandlerFunc) (*ReviewerProxy, *int) {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		upstream(w, r)
	}))
	t.Cleanup(srv.Close)
	return NewWithServices("internal-test", srv.URL, srv.URL, srv.URL, srv.Client()), &calls
}

// chunked hides the length so only the streaming limit can catch it.
type chunked struct{ io.Reader }

func TestJSONBodyLimit_EveryPOSTHandler(t *testing.T) {
	p, calls := newHardeningProxy(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	big := `{"reason":"` + strings.Repeat("a", maxJSONBody) + `"}`
	handlers := map[string]http.HandlerFunc{
		"review":     p.Review,
		"suspend":    p.Suspend,
		"reactivate": p.Reactivate,
		"resolve":    p.ResolveReconciliation,
		"activate":   p.ActivateSubscription,
		"revoke":     p.RevokeSubscription,
		"reject":     p.RejectPayout,
		"resolveTkt": p.ResolveTicket,
		"accept":     p.AcceptTicket,
	}
	for name, h := range handlers {
		for _, body := range []io.Reader{strings.NewReader(big), chunked{strings.NewReader(big)}} {
			req := httptest.NewRequest(http.MethodPost, "/api/x", body)
			req.Header.Set("X-Reviewer-Token", "rev")
			rec := httptest.NewRecorder()
			h(rec, req)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Errorf("%s (len %d): status = %d, want 413", name, req.ContentLength, rec.Code)
			}
		}
	}
	if *calls != 0 {
		t.Errorf("oversized bodies reached upstream %d times", *calls)
	}

	// A normal-sized body still goes through.
	req := httptest.NewRequest(http.MethodPost, "/api/payouts/reject", strings.NewReader(`{"payout_id":"p1","reason":"bad iban"}`))
	req.Header.Set("X-Reviewer-Token", "rev")
	rec := httptest.NewRecorder()
	p.RejectPayout(rec, req)
	if rec.Code != http.StatusOK || *calls != 1 {
		t.Errorf("normal body: status = %d, upstream calls = %d", rec.Code, *calls)
	}
}

func TestUploadBodyLimit(t *testing.T) {
	p, _ := newHardeningProxy(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	tooBig := bytes.Repeat([]byte("x"), maxUploadBody+1)

	for name, body := range map[string]io.Reader{"with length": bytes.NewReader(tooBig), "chunked": chunked{bytes.NewReader(tooBig)}} {
		req := httptest.NewRequest(http.MethodPost, "/api/tickets/attachment?ticket_id=t1", body)
		req.Header.Set("X-Reviewer-Token", "rev")
		req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
		rec := httptest.NewRecorder()
		p.TicketAttachment(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status = %d, want 413", name, rec.Code)
		}
	}

	// Uploads are exempt from the 64 KB JSON cap.
	req := httptest.NewRequest(http.MethodPost, "/api/tickets/attachment?ticket_id=t1", bytes.NewReader(bytes.Repeat([]byte("x"), 1<<20)))
	req.Header.Set("X-Reviewer-Token", "rev")
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rec := httptest.NewRecorder()
	p.TicketAttachment(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("1 MB upload: status = %d, want 200", rec.Code)
	}
}

func TestUpstreamErrors_OnlyJSONContractRelayed(t *testing.T) {
	cases := []struct {
		name, contentType, body string
		status                  int
		want                    string
	}{
		{"plain-text panic", "text/plain; charset=utf-8", "panic: runtime error at /srv/handlers.go:12\nmongodb://user:pw@db", 500, `{"error":"upstream error"}`},
		{"html gateway page", "text/html", "<html><body>nginx 502</body></html>", 502, `{"error":"upstream error"}`},
		{"json without error field", "application/json", `{"stack":"/srv/x.go:1"}`, 500, `{"error":"upstream error"}`},
		{"json contract", "application/json", `{"error":"reason is required","code":"bad_request","request_id":"r1","debug":"internal"}`, 400, `{"error":"reason is required","code":"bad_request","request_id":"r1"}`},
		{"json 503 with message", "application/json; charset=utf-8", `{"error":"service_unavailable","message":"Authentication service is temporarily unavailable."}`, 503, `{"error":"service_unavailable","message":"Authentication service is temporarily unavailable."}`},
		{"json 401", "application/json", `{"error":"invalid reviewer token"}`, 401, `{"error":"invalid reviewer token"}`},
	}
	for _, tc := range cases {
		p, _ := newHardeningProxy(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", tc.contentType)
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		for _, call := range []func(http.ResponseWriter, *http.Request){p.Queue, p.DocumentView, p.TicketAttachment} {
			req := httptest.NewRequest(http.MethodGet, "/api/x?token=abc&ticket_id=t1", nil)
			if strings.Contains(runtimeName(call), "TicketAttachment") {
				req = httptest.NewRequest(http.MethodPost, "/api/x?ticket_id=t1", strings.NewReader("--x--"))
			}
			req.Header.Set("X-Reviewer-Token", "rev")
			rec := httptest.NewRecorder()
			call(rec, req)
			if rec.Code != tc.status {
				t.Errorf("%s: status = %d, want %d", tc.name, rec.Code, tc.status)
			}
			if got := strings.TrimSpace(rec.Body.String()); got != tc.want {
				t.Errorf("%s: body = %s, want %s", tc.name, got, tc.want)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("%s: Content-Type = %q", tc.name, ct)
			}
		}
	}
}

func TestUpstreamSuccess_StreamedUnchanged(t *testing.T) {
	p, _ := newHardeningProxy(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNG-bytes"))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/documents/view?token=abc", nil)
	req.Header.Set("X-Reviewer-Token", "rev")
	rec := httptest.NewRecorder()
	p.DocumentView(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || rec.Body.String() != "\x89PNG-bytes" {
		t.Errorf("got %d %q %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestGETBodyNotForwarded(t *testing.T) {
	var gotBody string
	p, _ := newHardeningProxy(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/queue", strings.NewReader("smuggled"))
	req.Header.Set("X-Reviewer-Token", "rev")
	p.Queue(httptest.NewRecorder(), req)
	if gotBody != "" {
		t.Errorf("GET body forwarded upstream: %q", gotBody)
	}
}
