package main

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy"
)

func testHandler(t *testing.T, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	srv := httptest.NewServer(upstream)
	t.Cleanup(srv.Close)
	// Every service (auth, user, chat, notification, gateway) points at the
	// same stub so a route's upstream path can be asserted.
	p := proxy.NewWithAllServices("internal-test", srv.URL, srv.URL, srv.URL, srv.URL, srv.URL, srv.Client())
	return newHandler(p, "../../web")
}

func serve(h http.Handler, method, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("X-Reviewer-Token", "rev-test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSecurityHeaders_EveryResponse(t *testing.T) {
	h := testHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	})

	for _, target := range []string{"/", "/js/boot.js", "/js/pages/kyc.js", "/js/pages/overview.js", "/style.css", "/healthz", "/api/overview", "/api/queue", "/api/nope", "/missing.js"} {
		rec := serve(h, http.MethodGet, target)
		hdr := rec.Header()
		csp := hdr.Get("Content-Security-Policy")
		for _, directive := range []string{
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self'",
			"font-src 'self'",
			"img-src 'self' blob: data:",
			"connect-src 'self' wss://example.com",
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'self'",
		} {
			if !strings.Contains(csp, directive) {
				t.Errorf("%s: CSP %q missing %q", target, csp, directive)
			}
		}
		if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
			t.Errorf("%s: CSP must not allow inline/eval: %q", target, csp)
		}
		want := map[string]string{
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy":        "no-referrer",
			"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
		}
		for k, v := range want {
			if got := hdr.Get(k); got != v {
				t.Errorf("%s: %s = %q, want %q", target, k, got, v)
			}
		}
		isAPI := strings.HasPrefix(target, "/api/")
		if got := hdr.Get("Cache-Control"); isAPI && got != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", target, got)
		} else if !isAPI && got == "no-store" {
			t.Errorf("%s: static asset should stay cacheable, got no-store", target)
		}
	}
}

func TestContentSecurityPolicy_WebSocketOrigin(t *testing.T) {
	plain := httptest.NewRequest(http.MethodGet, "http://localhost:8090/", nil)
	if csp := contentSecurityPolicy(plain); !strings.Contains(csp, "connect-src 'self' wss://localhost:8090 ws://localhost:8090;") {
		t.Errorf("plain-http CSP should allow same-host ws/wss: %q", csp)
	}

	behindTLS := httptest.NewRequest(http.MethodGet, "http://kyc.example/", nil)
	behindTLS.Header.Set("X-Forwarded-Proto", "https")
	if csp := contentSecurityPolicy(behindTLS); !strings.Contains(csp, "connect-src 'self' wss://kyc.example;") {
		t.Errorf("TLS CSP should allow only wss: %q", csp)
	}

	evil := httptest.NewRequest(http.MethodGet, "http://x/", nil)
	evil.Host = "evil.example; script-src *"
	if csp := contentSecurityPolicy(evil); !strings.Contains(csp, "connect-src 'self';") || strings.Contains(csp, "evil") {
		t.Errorf("invalid Host must not be echoed into CSP: %q", csp)
	}
}

func TestStatic_OnlyUIAssetsServed(t *testing.T) {
	h := testHandler(t, func(http.ResponseWriter, *http.Request) {})
	for target, want := range map[string]int{
		"/": http.StatusOK,
		// http.ServeFile canonicalises /index.html to ./ with a redirect.
		"/index.html":                            http.StatusMovedPermanently,
		"/style.css":                             http.StatusOK,
		"/js/boot.js":                            http.StatusOK,
		"/js/app.js":                             http.StatusOK,
		"/js/pages/kyc.js":                       http.StatusOK,
		"/js/pages/overview.js":                  http.StatusOK,
		"/js/pages/jobs.js":                      http.StatusOK,
		"/js/pages/services.js":                  http.StatusOK,
		"/js/pages/notifications.js":             http.StatusOK,
		"/js/core/cod-banner.js":                 http.StatusOK,
		"/fonts/IBMPlexSansArabic-Regular.woff2": http.StatusOK,
		"/fonts/IBMPlexSansArabic-Bold.woff2":    http.StatusOK,
		// The OFL license and any other file under web/fonts/ stay unserved.
		"/fonts/IBMPlexSansArabic-OFL.txt":     http.StatusNotFound,
		"/fonts/IBMPlexSansArabic-Regular.ttf": http.StatusNotFound,
		"/fonts/nope.woff2":                    http.StatusNotFound,
		"/js/package.json":                     http.StatusNotFound,
		"/app.js":                              http.StatusNotFound,
		"/legacy.js":                           http.StatusNotFound,
		"/app_test.js":                         http.StatusNotFound,
		"/testdom.js":                          http.StatusNotFound,
		"/xss_test.js":                         http.StatusNotFound,
		"/go.mod":                              http.StatusNotFound,
		"/.git/HEAD":                           http.StatusNotFound,
		"/web/index.html":                      http.StatusNotFound,
	} {
		if got := serve(h, http.MethodGet, target).Code; got != want {
			t.Errorf("GET %s = %d, want %d", target, got, want)
		}
	}
	if got := serve(h, http.MethodPost, "/").Code; got != http.StatusMethodNotAllowed {
		t.Errorf("POST / = %d, want 405", got)
	}
	if ct := serve(h, http.MethodGet, "/js/boot.js").Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("boot.js Content-Type = %q (nosniff needs a JS type)", ct)
	}
}

func TestSecurityHeaders_DocumentStreamKeepsUpstreamType(t *testing.T) {
	h := testHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.4"))
	})
	for _, target := range []string{"/api/documents/view?token=abc", "/api/chat/attachments/view?token=abc"} {
		rec := serve(h, http.MethodGet, target)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/pdf" || rec.Body.String() != "%PDF-1.4" {
			t.Errorf("%s: got %d %q %q", target, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing no-store/nosniff on document stream", target)
		}
	}
}

func TestRoutes_JobPathParamsReachUpstream(t *testing.T) {
	var gotPath string
	var gotMethod string
	h := testHandler(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})

	if got := serve(h, http.MethodGet, "/api/jobs/job-98712").Code; got != http.StatusOK {
		t.Errorf("GET /api/jobs/{id} = %d, want 200", got)
	}
	if gotPath != "/admin/jobs/job-98712" {
		t.Errorf("upstream path = %q, want /admin/jobs/job-98712", gotPath)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/jobs/job-98712/cancel", strings.NewReader(`{"reason":"duplicate order"}`))
	req.Header.Set("X-Reviewer-Token", "rev-test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("POST /api/jobs/{id}/cancel = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/admin/jobs/job-98712/cancel" {
		t.Errorf("upstream path = %q, want /admin/jobs/job-98712/cancel", gotPath)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("upstream method = %q, want POST", gotMethod)
	}
}

func TestRoutes_AuditAndVersionReachTheirServices(t *testing.T) {
	var gotPath string
	var gotMethod string
	h := testHandler(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})

	if got := serve(h, http.MethodGet, "/api/audit?action=job.cancel").Code; got != http.StatusOK {
		t.Errorf("GET /api/audit = %d, want 200", got)
	}
	if gotPath != "/admin/audit" {
		t.Errorf("upstream path = %q, want /admin/audit", gotPath)
	}

	if got := serve(h, http.MethodGet, "/api/version").Code; got != http.StatusOK {
		t.Errorf("GET /api/version = %d, want 200", got)
	}
	if gotPath != "/admin/version" {
		t.Errorf("upstream path = %q, want /admin/version", gotPath)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/version", strings.NewReader(`{"reason":"security patch","latest_version":"1.5.2"}`))
	req.Header.Set("X-Reviewer-Token", "rev-test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("PUT /api/version = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if gotMethod != http.MethodPut {
		t.Errorf("upstream method = %q, want PUT", gotMethod)
	}
}

func TestRoutes_NotificationEndpointsReachTheirUpstreams(t *testing.T) {
	var gotPath string
	var gotMethod string
	h := testHandler(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})

	body := `{"reason":"Emergency maintenance","audience":{"kind":"role","role":"customers"},"title":{"en":"Maintenance","ar":"صيانة"},"body":{"en":"Tonight","ar":"الليلة"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/notifications/send", strings.NewReader(body))
	req.Header.Set("X-Reviewer-Token", "rev-test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("POST /api/notifications/send = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/admin/notifications/send" {
		t.Errorf("upstream path = %q, want /admin/notifications/send", gotPath)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("upstream method = %q, want POST", gotMethod)
	}

	if got := serve(h, http.MethodGet, "/api/notifications/sends?page=1&limit=20").Code; got != http.StatusOK {
		t.Errorf("GET /api/notifications/sends = %d, want 200", got)
	}
	if gotPath != "/admin/notifications/sends" {
		t.Errorf("upstream path = %q, want /admin/notifications/sends", gotPath)
	}

	if got := serve(h, http.MethodGet, "/api/notifications/sends/send-1").Code; got != http.StatusOK {
		t.Errorf("GET /api/notifications/sends/{id} = %d, want 200", got)
	}
	if gotPath != "/admin/notifications/sends/send-1" {
		t.Errorf("upstream path = %q, want /admin/notifications/sends/send-1", gotPath)
	}
}

func TestRoutes_MethodAllowList(t *testing.T) {
	upstreamCalls := 0
	h := testHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	all := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, "TRACE"}
	for _, rt := range apiRoutes(nil) {
		for _, m := range all {
			if slices.Contains(rt.methods, m) {
				continue
			}
			rec := serve(h, m, rt.path)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405", m, rt.path, rec.Code)
			}
			if got, want := rec.Header().Get("Allow"), strings.Join(rt.methods, ", "); got != want {
				t.Errorf("%s %s Allow = %q, want %q", m, rt.path, got, want)
			}
		}
	}
	if upstreamCalls != 0 {
		t.Errorf("disallowed methods reached upstream %d times", upstreamCalls)
	}
	if got := serve(h, http.MethodPost, "/healthz").Code; got != http.StatusMethodNotAllowed {
		t.Errorf("POST /healthz = %d, want 405", got)
	}
}

func TestRoutes_AdminPayoutAliasesRemoved(t *testing.T) {
	upstreamCalls := 0
	h := testHandler(t, func(http.ResponseWriter, *http.Request) { upstreamCalls++ })
	for _, m := range []string{http.MethodGet, http.MethodPost} {
		for _, path := range []string{"/admin/payouts", "/admin/payouts/reject"} {
			if got := serve(h, m, path).Code; got != http.StatusNotFound && got != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 404/405", m, path, got)
			}
		}
	}
	if upstreamCalls != 0 {
		t.Errorf("removed aliases reached upstream %d times", upstreamCalls)
	}
}
