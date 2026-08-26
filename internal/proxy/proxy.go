// Package proxy forwards authenticated reviewer requests to auth-service.
//
// Security model (ADR-0021): the browser sends only the reviewer's
// X-Reviewer-Token; this proxy injects X-Internal-Token server-side from its
// own environment. The internal secret never reaches any client, and the
// console makes no authorization decisions of its own — auth-service remains
// the single authentication authority for every proxied call.
package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const reviewerTokenHeader = "X-Reviewer-Token"

type ReviewerProxy struct {
	internalServiceToken string
	authServiceURL       string
	client               *http.Client
}

func New(internalServiceToken, authServiceURL string, client *http.Client) *ReviewerProxy {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &ReviewerProxy{
		internalServiceToken: internalServiceToken,
		authServiceURL:       strings.TrimSuffix(authServiceURL, "/"),
		client:               client,
	}
}

// forward relays method+path+body to auth-service with both tokens attached.
// It returns the upstream status code and body verbatim; the console never
// interprets or rewrites auth-service responses.
func (p *ReviewerProxy) forward(w http.ResponseWriter, r *http.Request, path string) {
	reviewerToken := r.Header.Get(reviewerTokenHeader)
	if reviewerToken == "" {
		http.Error(w, `{"error":"reviewer token required"}`, http.StatusUnauthorized)
		return
	}

	var bodyReader io.Reader
	if r.Body != nil {
		b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB bound
		if err != nil {
			http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
			return
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(r.Context(), r.Method, p.authServiceURL+path, bodyReader)
	if err != nil {
		log.Printf("[CONSOLE] failed to build upstream request for %s: %v", path, err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", p.internalServiceToken)
	req.Header.Set(reviewerTokenHeader, reviewerToken)

	resp, err := p.client.Do(req) // #nosec G704 -- URL is constructed from internal service config (AUTH_SERVICE_URL)
	if err != nil {
		log.Printf("[CONSOLE] upstream call to %s failed: %v", path, err)
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Pass through content type so document streaming works for images/PDFs.
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		log.Printf("[CONSOLE] failed to relay upstream response for %s: %v", path, err)
	}
}

// Queue proxies GET /auth/kyb-kye/pending.
func (p *ReviewerProxy) Queue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	p.forward(w, r, "/auth/kyb-kye/pending")
}

// reviewRequest mirrors the auth-service contract. The console enforces the
// mandatory rejection reason client-side as UX; the API-layer rule in
// ReviewKYBKYESubmissions remains the authoritative defense (ADR-0021).
type reviewRequest struct {
	UserID string `json:"user_id"`
	Action string `json:"action"`
	Reason string `json:"reason"`
}

// Review proxies POST /auth/kyb-kye/review after validating the payload shape
// locally so reviewers get immediate feedback on malformed submissions.
func (p *ReviewerProxy) Review(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req reviewRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == "" {
		http.Error(w, `{"error":"user_id is required"}`, http.StatusBadRequest)
		return
	}
	if req.Action != "approve" && req.Action != "reject" {
		http.Error(w, `{"error":"action must be approve or reject"}`, http.StatusBadRequest)
		return
	}
	// Mirror of the server-side ADR-0021 rule for instant UI feedback.
	if req.Action == "reject" && strings.TrimSpace(req.Reason) == "" {
		http.Error(w, `{"error":"reason is required for rejection"}`, http.StatusBadRequest)
		return
	}
	if len(req.Reason) > 1000 {
		http.Error(w, `{"error":"reason exceeds maximum length of 1000 characters"}`, http.StatusBadRequest)
		return
	}

	payload, err := json.Marshal(req)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forward(w, r, "/auth/kyb-kye/review")
}

// DocumentView proxies GET /auth/documents/view?token=... streaming the
// decrypted document bytes to the reviewer's browser. The signed view URL from
// the pending queue is consumed server-side by this proxy and never handed to
// the client (browsers cannot attach the required headers to <img> requests).
func (p *ReviewerProxy) DocumentView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	viewToken := r.URL.Query().Get("token")
	if viewToken == "" || strings.ContainsAny(viewToken, "&/#?") {
		http.Error(w, `{"error":"token is required"}`, http.StatusBadRequest)
		return
	}
	p.forward(w, r, "/auth/documents/view?token="+viewToken)
}
