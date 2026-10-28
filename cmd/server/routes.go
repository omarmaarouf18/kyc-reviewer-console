package main

import (
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy"
)

// newHandler builds the console's full HTTP surface: API routes, the static
// UI, and the security headers applied to every response.
func newHandler(p *proxy.ReviewerProxy, webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/queue", p.Queue)
	mux.HandleFunc("/api/review", p.Review)
	mux.HandleFunc("/api/documents/view", p.DocumentView)
	mux.HandleFunc("/api/documents/user", p.UserDocuments)
	mux.HandleFunc("/api/accounts", p.Accounts)
	mux.HandleFunc("/api/accounts/suspend", p.Suspend)
	mux.HandleFunc("/api/accounts/reactivate", p.Reactivate)
	mux.HandleFunc("/api/reconciliation/queue", p.ReconciliationQueue)
	mux.HandleFunc("/api/reconciliation/resolve", p.ResolveReconciliation)
	mux.HandleFunc("/api/subscriptions", p.Subscriptions)
	mux.HandleFunc("/api/subscriptions/activate", p.ActivateSubscription)
	mux.HandleFunc("/api/subscriptions/revoke", p.RevokeSubscription)
	mux.HandleFunc("/api/payouts", p.Payouts)
	mux.HandleFunc("/admin/payouts", p.Payouts)
	mux.HandleFunc("/api/payouts/reject", p.RejectPayout)
	mux.HandleFunc("/admin/payouts/reject", p.RejectPayout)
	mux.HandleFunc("/api/me", p.Me)
	mux.HandleFunc("/api/tickets", p.Tickets)
	mux.HandleFunc("/api/tickets/accept", p.AcceptTicket)
	mux.HandleFunc("/api/tickets/history", p.TicketsHistory)
	mux.HandleFunc("/api/chat/history", p.TicketsHistory)
	mux.HandleFunc("/api/tickets/resolve", p.ResolveTicket)
	mux.HandleFunc("/api/tickets/attachment", p.TicketAttachment)
	mux.HandleFunc("/api/chat/attachments/view", p.AttachmentView)
	mux.HandleFunc("/api/chat/ws", p.ChatWebSocket)
	mux.Handle("/", staticHandler(webDir))
	return securityHeaders(mux)
}

// staticFiles is the complete set of UI assets served from webDir; anything
// else under web/ (tests, the DOM shim) is never exposed.
var staticFiles = map[string]string{
	"/":           "index.html",
	"/index.html": "index.html",
	"/app.js":     "app.js",
	"/style.css":  "style.css",
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
