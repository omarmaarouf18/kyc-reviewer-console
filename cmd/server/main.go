// kyc-reviewer-console: standalone reviewer console per saas-core ADR-0021.
//
// Executes the deferred Support Agent Console from ADR-0013, scoped to
// KYC/KYB/KYE review. Runs inside the internal network, injects the internal
// service token server-side, and serves a minimal browser UI.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/omarmaarouf18/kyc-reviewer-console/internal/config"
	"github.com/omarmaarouf18/kyc-reviewer-console/internal/proxy"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[CONSOLE] config error: %v", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	if cfg.TLSCertPath != "" && cfg.TLSKeyPath != "" && cfg.TLSCAPath != "" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCertPath, cfg.TLSKeyPath)
		if err != nil {
			log.Fatalf("[CONSOLE] failed to load TLS keypair: %v", err)
		}
		caCert, err := os.ReadFile(cfg.TLSCAPath)
		if err != nil {
			log.Fatalf("[CONSOLE] failed to read CA cert: %v", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caCert) {
			log.Fatalf("[CONSOLE] failed to parse CA cert from %s", cfg.TLSCAPath)
		}
		client = &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					Certificates: []tls.Certificate{cert},
					RootCAs:      pool,
					MinVersion:   tls.VersionTLS12,
				},
			},
		}
	}

	p := proxy.New(cfg.InternalServiceToken, cfg.AuthServiceURL, client)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/queue", p.Queue)
	mux.HandleFunc("/api/review", p.Review)
	mux.HandleFunc("/api/documents/view", p.DocumentView)
	mux.HandleFunc("/api/accounts", p.Accounts)
	mux.HandleFunc("/api/accounts/suspend", p.Suspend)
	mux.HandleFunc("/api/accounts/reactivate", p.Reactivate)
	mux.Handle("/", http.FileServer(http.Dir("web")))

	addr := ":" + cfg.Port
	srv := &http.Server{
		Addr:              addr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	log.Printf("[CONSOLE] listening on %s (auth-service: %s, env: %s)", addr, cfg.AuthServiceURL, cfg.AppEnv)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("[CONSOLE] server exited: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		// #nosec G706 //nolint:gosec -- request path is sanitized of CR/LF before interpolation
		log.Printf("[CONSOLE] %s %s %s", r.Method, sanitizeForLog(r.URL.Path), time.Since(start))
	})
}

// sanitizeForLog strips CR/LF so request paths cannot inject log lines (G706).
func sanitizeForLog(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
}
