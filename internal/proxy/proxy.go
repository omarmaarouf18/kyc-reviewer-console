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
	"net/url"
	"strings"
	"time"
)

const reviewerTokenHeader = "X-Reviewer-Token"

type ReviewerProxy struct {
	internalServiceToken string
	authServiceURL       string
	userServiceURL       string
	chatServiceURL       string
	client               *http.Client
}

func New(internalServiceToken, authServiceURL string, client *http.Client) *ReviewerProxy {
	return NewWithServices(internalServiceToken, authServiceURL, "https://user-service:3003", "https://chat-service:3005", client)
}

func NewWithUserService(internalServiceToken, authServiceURL, userServiceURL string, client *http.Client) *ReviewerProxy {
	return NewWithServices(internalServiceToken, authServiceURL, userServiceURL, "https://chat-service:3005", client)
}

func NewWithServices(internalServiceToken, authServiceURL, userServiceURL, chatServiceURL string, client *http.Client) *ReviewerProxy {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	if userServiceURL == "" {
		userServiceURL = "https://user-service:3003"
	}
	if chatServiceURL == "" {
		chatServiceURL = "https://chat-service:3005"
	}
	return &ReviewerProxy{
		internalServiceToken: internalServiceToken,
		authServiceURL:       strings.TrimSuffix(authServiceURL, "/"),
		userServiceURL:       strings.TrimSuffix(userServiceURL, "/"),
		chatServiceURL:       strings.TrimSuffix(chatServiceURL, "/"),
		client:               client,
	}
}

// forward relays method+path+body to a backend service with both tokens attached.
func (p *ReviewerProxy) forwardToService(w http.ResponseWriter, r *http.Request, baseURL, path string) {
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

	// #nosec G704 //nolint:gosec -- scheme and host come exclusively from internal config; query string is URL-escaped by callers
	req, err := http.NewRequestWithContext(r.Context(), r.Method, baseURL+path, bodyReader)
	if err != nil {
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized
		log.Printf("[CONSOLE] failed to build upstream request for %s: %v", sanitizeLog(path), sanitizeLog(err.Error()))
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", p.internalServiceToken)
	req.Header.Set(reviewerTokenHeader, reviewerToken)

	// #nosec G704 //nolint:gosec -- same request as above: config-controlled host, escaped query string
	resp, err := p.client.Do(req)
	if err != nil {
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized
		log.Printf("[CONSOLE] upstream call to %s failed: %v", sanitizeLog(path), sanitizeLog(err.Error()))
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized
		log.Printf("[CONSOLE] failed to relay upstream response for %s: %v", sanitizeLog(path), sanitizeLog(err.Error()))
	}
}

// sanitizeLog strips CR/LF so request-derived strings cannot forge log lines
// (G706 log-injection discipline, mirroring saas-core handlers).
func sanitizeLog(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
}

// forward relays method+path+body to auth-service with both tokens attached.
func (p *ReviewerProxy) forward(w http.ResponseWriter, r *http.Request, path string) {
	p.forwardToService(w, r, p.authServiceURL, path)
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
	// Escape the request-derived token so it cannot alter the upstream URL
	// structure (SSF/SSRF defense for the G704-tainted transport above).
	p.forward(w, r, "/auth/documents/view?token="+url.QueryEscape(viewToken))
}

// Accounts proxies GET /auth/accounts forwarding query parameters (search, role, status, page, limit).
func (p *ReviewerProxy) Accounts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/auth/accounts"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forward(w, r, upstreamPath)
}

type suspendRequest struct {
	UserID string `json:"user_id"`
	Reason string `json:"reason"`
}

// Suspend proxies POST /auth/accounts/suspend with local payload shape validation (ADR-0022).
func (p *ReviewerProxy) Suspend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req suspendRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == "" {
		http.Error(w, `{"error":"user_id is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		http.Error(w, `{"error":"reason is required for suspension"}`, http.StatusBadRequest)
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
	p.forward(w, r, "/auth/accounts/suspend")
}

type reactivateRequest struct {
	UserID string `json:"user_id"`
	Reason string `json:"reason,omitempty"`
}

// Reactivate proxies POST /auth/accounts/reactivate with local payload shape validation (ADR-0022).
func (p *ReviewerProxy) Reactivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req reactivateRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == "" {
		http.Error(w, `{"error":"user_id is required"}`, http.StatusBadRequest)
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
	p.forward(w, r, "/auth/accounts/reactivate")
}

// ReconciliationQueue proxies GET /admin/reconciliation/queue to user-service (ADR-0023).
func (p *ReviewerProxy) ReconciliationQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/reconciliation/queue"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.userServiceURL, upstreamPath)
}

type reconciliationResolveRequest struct {
	JobID    string `json:"job_id"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

// ResolveReconciliation proxies POST /admin/reconciliation/resolve to user-service with local validation (ADR-0023).
func (p *ReviewerProxy) ResolveReconciliation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req reconciliationResolveRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.JobID == "" {
		http.Error(w, `{"error":"job_id is required"}`, http.StatusBadRequest)
		return
	}
	if req.Decision != "release_to_employee" && req.Decision != "refund_to_customer" {
		http.Error(w, `{"error":"decision must be release_to_employee or refund_to_customer"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		http.Error(w, `{"error":"reason is required for dispute resolution"}`, http.StatusBadRequest)
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
	p.forwardToService(w, r, p.userServiceURL, "/admin/reconciliation/resolve")
}

// Subscriptions proxies GET /admin/subscriptions to user-service (ADR-0023).
func (p *ReviewerProxy) Subscriptions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/subscriptions"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.userServiceURL, upstreamPath)
}

type activateSubscriptionRequest struct {
	TenantID       string `json:"tenant_id"`
	SubscriptionID string `json:"subscription_id,omitempty"`
	DurationDays   int    `json:"duration_days,omitempty"`
}

// ActivateSubscription proxies POST /admin/subscriptions/activate to user-service (ADR-0023).
func (p *ReviewerProxy) ActivateSubscription(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req activateSubscriptionRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.TenantID == "" && req.SubscriptionID == "" {
		http.Error(w, `{"error":"tenant_id or subscription_id is required"}`, http.StatusBadRequest)
		return
	}

	payload, err := json.Marshal(req)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.userServiceURL, "/admin/subscriptions/activate")
}

type revokeSubscriptionRequest struct {
	TenantID       string `json:"tenant_id"`
	SubscriptionID string `json:"subscription_id,omitempty"`
	Reason         string `json:"reason"`
}

// RevokeSubscription proxies POST /admin/subscriptions/revoke with mandatory reason validation (ADR-0023).
func (p *ReviewerProxy) RevokeSubscription(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req revokeSubscriptionRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.TenantID == "" && req.SubscriptionID == "" {
		http.Error(w, `{"error":"tenant_id or subscription_id is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		http.Error(w, `{"error":"reason is required for revocation"}`, http.StatusBadRequest)
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
	p.forwardToService(w, r, p.userServiceURL, "/admin/subscriptions/revoke")
}

// Tickets proxies GET /admin/tickets to chat-service (ADR-0023).
func (p *ReviewerProxy) Tickets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/tickets"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.chatServiceURL, upstreamPath)
}

type resolveTicketRequest struct {
	TicketID       string `json:"ticket_id"`
	ResolutionNote string `json:"resolution_note"`
}

// ResolveTicket proxies POST /admin/tickets/resolve with mandatory note validation (ADR-0023).
func (p *ReviewerProxy) ResolveTicket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req resolveTicketRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.TicketID == "" {
		http.Error(w, `{"error":"ticket_id is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.ResolutionNote) == "" {
		http.Error(w, `{"error":"resolution_note is required"}`, http.StatusBadRequest)
		return
	}
	if len(req.ResolutionNote) > 1000 {
		http.Error(w, `{"error":"resolution_note exceeds maximum length of 1000 characters"}`, http.StatusBadRequest)
		return
	}

	payload, err := json.Marshal(req)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.chatServiceURL, "/admin/tickets/resolve")
}
