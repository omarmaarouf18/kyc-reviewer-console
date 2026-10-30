package main

import (
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy"
)

// route is one API endpoint and the only methods it accepts.
type route struct {
	path    string
	methods []string
	handler http.HandlerFunc
}

func apiRoutes(p *proxy.ReviewerProxy) []route {
	get := []string{http.MethodGet}
	post := []string{http.MethodPost}
	return []route{
		{"/api/queue", get, p.Queue},
		{"/api/review", post, p.Review},
		{"/api/documents/view", get, p.DocumentView},
		{"/api/documents/user", get, p.UserDocuments},
		{"/api/accounts", get, p.Accounts},
		{"/api/accounts/suspend", post, p.Suspend},
		{"/api/accounts/reactivate", post, p.Reactivate},
		{"/api/reconciliation/queue", get, p.ReconciliationQueue},
		{"/api/reconciliation/resolve", post, p.ResolveReconciliation},
		{"/api/subscriptions", get, p.Subscriptions},
		{"/api/subscriptions/activate", post, p.ActivateSubscription},
		{"/api/subscriptions/revoke", post, p.RevokeSubscription},
		{"/api/payouts", get, p.Payouts},
		{"/api/payouts/reject", post, p.RejectPayout},
		{"/api/me", get, p.Me},
		{"/api/tickets", get, p.Tickets},
		{"/api/tickets/accept", post, p.AcceptTicket},
		{"/api/tickets/history", get, p.TicketsHistory},
		{"/api/chat/history", get, p.TicketsHistory},
		{"/api/tickets/resolve", post, p.ResolveTicket},
		{"/api/tickets/attachment", post, p.TicketAttachment},
		{"/api/chat/attachments/view", get, p.AttachmentView},
		{"/api/chat/ws", get, p.ChatWebSocket},
	}
}

// newHandler builds the console's full HTTP surface: API routes, the static
// UI, and the security headers applied to every response.
func newHandler(p *proxy.ReviewerProxy, webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/healthz", allowMethods([]string{http.MethodGet, http.MethodHead}, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	for _, rt := range apiRoutes(p) {
		mux.Handle(rt.path, allowMethods(rt.methods, rt.handler))
	}
	mux.Handle("/", staticHandler(webDir))
	return securityHeaders(mux)
}

// allowMethods answers 405 (with an Allow header) before the handler runs
// for any method outside the route's allow-list.
func allowMethods(methods []string, h http.HandlerFunc) http.Handler {
	allow := strings.Join(methods, ", ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !slices.Contains(methods, r.Method) {
			w.Header().Set("Allow", allow)
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		h(w, r)
	})
}

// staticFiles is the complete set of UI assets served from webDir; anything
// else under web/ (tests, the DOM shim) is never exposed. Frontend code lives
// in native ES modules under web/js/ (CONSOLE-V2 item 1): every module is
// listed explicitly, no wildcard — files must NOT be served just because
// they sit in web/js/.
var staticFiles = map[string]string{
	"/":                          "index.html",
	"/index.html":                "index.html",
	"/style.css":                 "style.css",
	"/js/boot.js":                "js/boot.js",
	"/js/main.js":                "js/main.js",
	"/js/app.js":                 "js/app.js",
	"/js/core/api.js":            "js/core/api.js",
	"/js/core/dom.js":            "js/core/dom.js",
	"/js/core/format.js":         "js/core/format.js",
	"/js/core/i18n.js":           "js/core/i18n.js",
	"/js/core/router.js":         "js/core/router.js",
	"/js/core/session.js":        "js/core/session.js",
	"/js/core/state.js":          "js/core/state.js",
	"/js/core/ui/dialog.js":      "js/core/ui/dialog.js",
	"/js/core/ui/search.js":      "js/core/ui/search.js",
	"/js/core/ui/table.js":       "js/core/ui/table.js",
	"/js/core/ui/toast.js":       "js/core/ui/toast.js",
	"/js/pages/accounts.js":      "js/pages/accounts.js",
	"/js/pages/disputes.js":      "js/pages/disputes.js",
	"/js/pages/kyc.js":           "js/pages/kyc.js",
	"/js/pages/kycdocs.js":       "js/pages/kycdocs.js",
	"/js/pages/payouts.js":       "js/pages/payouts.js",
	"/js/pages/subscriptions.js": "js/pages/subscriptions.js",
	"/js/pages/tickets.js":       "js/pages/tickets.js",
}

func staticHandler(webDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, ok := staticFiles[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		http.ServeFile(w, r, filepath.Join(webDir, name))
	})
}

// validHost guards the Host header before it is echoed into the CSP.
var validHost = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$`)

// contentSecurityPolicy allows only same-origin script/style/connect. The
// chat socket's ws(s):// origin is listed explicitly because older browsers
// do not treat 'self' as covering WebSocket schemes.
func contentSecurityPolicy(r *http.Request) string {
	connect := "'self'"
	if validHost.MatchString(r.Host) {
		connect += " wss://" + r.Host
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
			connect += " ws://" + r.Host
		}
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' blob: data:",
		"connect-src " + connect,
		"object-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	}, "; ")
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy(r))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
