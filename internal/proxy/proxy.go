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
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const reviewerTokenHeader = "X-Reviewer-Token"

const (
	// maxJSONBody caps every JSON POST body; the largest legitimate payload
	// is a 1000-character reason plus ids.
	maxJSONBody = 64 << 10
	// maxUploadBody caps ticket attachment uploads: chat-service's 10 MB
	// file limit plus multipart framing.
	maxUploadBody = 10<<20 + 64<<10
	// maxErrorBody bounds how much of an upstream error body is inspected.
	maxErrorBody = 64 << 10
)

type ReviewerProxy struct {
	internalServiceToken string
	authServiceURL       string
	userServiceURL       string
	chatServiceURL       string
	client               *http.Client
}

func New(internalServiceToken, authServiceURL string, client *http.Client) *ReviewerProxy {
	return NewWithServices(internalServiceToken, authServiceURL, "https://user-service:3003", "https://chat-service:3001", client)
}

func NewWithUserService(internalServiceToken, authServiceURL, userServiceURL string, client *http.Client) *ReviewerProxy {
	return NewWithServices(internalServiceToken, authServiceURL, userServiceURL, "https://chat-service:3001", client)
}

func NewWithServices(internalServiceToken, authServiceURL, userServiceURL, chatServiceURL string, client *http.Client) *ReviewerProxy {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	if userServiceURL == "" {
		userServiceURL = "https://user-service:3003"
	}
	if chatServiceURL == "" {
		chatServiceURL = "https://chat-service:3001"
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
	if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		b, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody))
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
		log.Printf("[CONSOLE] failed to build upstream request for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
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
		log.Printf("[CONSOLE] upstream call to %s failed: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	relayResponse(w, resp, path)
}

// relayResponse streams a successful upstream response through unchanged.
// Error responses (>= 400) are reduced to the services' JSON error contract
// ({"error", "message", "code", "request_id"}); anything else — plain-text
// panics, HTML error pages, unexpected fields — becomes a generic message
// with the same status, so upstream internals never reach the browser.
func relayResponse(w http.ResponseWriter, resp *http.Response, path string) {
	if resp.StatusCode >= http.StatusBadRequest {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(safeErrorBody(resp))
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized
		log.Printf("[CONSOLE] failed to relay upstream response for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
	}
}

// upstreamError is the JSON error contract shared by saas-core services
// (handlerutil.SafeError plus the "message" field some handlers add).
type upstreamError struct {
	Error     string `json:"error"`
	Message   string `json:"message,omitempty"`
	Code      string `json:"code,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

func safeErrorBody(resp *http.Response) []byte {
	generic := []byte(`{"error":"upstream error"}`)
	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		return generic
	}
	var e upstreamError
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxErrorBody)).Decode(&e); err != nil || e.Error == "" {
		return generic
	}
	b, err := json.Marshal(e)
	if err != nil {
		return generic
	}
	return b
}

// decodeJSON decodes a bounded JSON request body, answering 413 when it
// exceeds maxJSONBody and 400 when it is malformed.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.ContentLength > maxJSONBody {
		http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody)).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return false
	}
	return true
}

// forwardMultipartToService relays multipart requests up to 10MB to an upstream service.
func (p *ReviewerProxy) forwardMultipartToService(w http.ResponseWriter, r *http.Request, baseURL, path string) {
	reviewerToken := r.Header.Get(reviewerTokenHeader)
	if reviewerToken == "" {
		http.Error(w, `{"error":"reviewer token required"}`, http.StatusUnauthorized)
		return
	}

	if r.ContentLength > maxUploadBody {
		http.Error(w, `{"error":"attachment too large"}`, http.StatusRequestEntityTooLarge)
		return
	}
	// #nosec G704 //nolint:gosec -- scheme and host come exclusively from internal config
	req, err := http.NewRequestWithContext(r.Context(), r.Method, baseURL+path, http.MaxBytesReader(w, r.Body, maxUploadBody))
	if err != nil {
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized via sanitizeLog()
		log.Printf("[CONSOLE] failed to build upstream multipart request for %s: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	req.Header.Set("X-Internal-Token", p.internalServiceToken)
	req.Header.Set(reviewerTokenHeader, reviewerToken)

	// #nosec G704 //nolint:gosec -- config-controlled host
	resp, err := p.client.Do(req)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, `{"error":"attachment too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		// #nosec G706 //nolint:gosec -- path is a handler-defined constant and err text is sanitized via sanitizeLog()
		log.Printf("[CONSOLE] upstream multipart call to %s failed: %v", sanitizeLog(stripQuery(path)), upstreamErrText(err))
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	relayResponse(w, resp, path)
}

// upstreamErrText describes a transport error without its *url.Error
// wrapper, whose text carries the full upstream URL including query-string
// tokens (document view tokens, the chat socket's reviewer token).
func upstreamErrText(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return sanitizeLog(err.Error())
}

// stripQuery drops the query string so tokens and audit reasons never reach
// the log.
func stripQuery(path string) string {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		return path[:i]
	}
	return path
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
	if !decodeJSON(w, r, &req) {
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

// UserDocuments proxies GET /auth/reviewer/user-documents to auth-service.
// Mandatory audit reason (1–1000 chars) is required.
func (p *ReviewerProxy) UserDocuments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	userID := r.URL.Query().Get("user_id")
	email := r.URL.Query().Get("email")
	reason := strings.TrimSpace(r.URL.Query().Get("reason"))

	if userID == "" && email == "" {
		http.Error(w, `{"error":"user_id or email is required"}`, http.StatusBadRequest)
		return
	}
	if reason == "" {
		http.Error(w, `{"error":"reason is mandatory"}`, http.StatusBadRequest)
		return
	}
	if len(reason) > 1000 {
		http.Error(w, `{"error":"reason cannot exceed 1000 characters"}`, http.StatusBadRequest)
		return
	}

	q := url.Values{}
	if userID != "" {
		q.Set("user_id", userID)
	}
	if email != "" {
		q.Set("email", email)
	}
	q.Set("reason", reason)

	p.forward(w, r, "/auth/reviewer/user-documents?"+q.Encode())
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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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
// Services proxies GET /admin/services to user-service (marketplace moderation).
func (p *ReviewerProxy) Services(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/services"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.userServiceURL, upstreamPath)
}

// serviceID returns the {id} path value, escaped for the upstream URL.
func serviceID(r *http.Request) (string, bool) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return "", false
	}
	return url.PathEscape(id), true
}

// proxyServiceAction validates the mandatory reason and forwards the service
// moderation action (hide / unhide / photo removal) to user-service.
func (p *ReviewerProxy) proxyServiceAction(w http.ResponseWriter, r *http.Request, action string) {
	id, ok := serviceID(r)
	if !ok {
		http.Error(w, `{"error":"service_id is required"}`, http.StatusBadRequest)
		return
	}
	reason, ok := validateJobReason(w, r)
	if !ok {
		return
	}

	payload, err := json.Marshal(jobReasonRequest{Reason: reason})
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.userServiceURL, "/admin/services/"+id+"/"+action)
}

// HideService proxies POST /admin/services/{id}/hide.
func (p *ReviewerProxy) HideService(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	p.proxyServiceAction(w, r, "hide")
}

// UnhideService proxies POST /admin/services/{id}/unhide.
func (p *ReviewerProxy) UnhideService(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	p.proxyServiceAction(w, r, "unhide")
}

// RemoveServicePhoto proxies POST /admin/services/{id}/photo/remove.
func (p *ReviewerProxy) RemoveServicePhoto(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	p.proxyServiceAction(w, r, "photo/remove")
}

// Jobs proxies GET /admin/jobs to user-service (job search across tenants).
func (p *ReviewerProxy) Jobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/jobs"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.userServiceURL, upstreamPath)
}

// jobID returns the {id} path value, escaped for the upstream URL.
func jobID(r *http.Request) (string, bool) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return "", false
	}
	return url.PathEscape(id), true
}

// JobDetail proxies GET /admin/jobs/{id}. The response carries unmasked
// phones; the upstream records the job.view audit entry for every call.
func (p *ReviewerProxy) JobDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	id, ok := jobID(r)
	if !ok {
		http.Error(w, `{"error":"job id is required"}`, http.StatusBadRequest)
		return
	}
	p.forwardToService(w, r, p.userServiceURL, "/admin/jobs/"+id)
}

type jobReasonRequest struct {
	Reason string `json:"reason"`
}

// validateJobReason enforces the shared contract of the job mutations: a
// reason is mandatory and at most 1000 characters.
func validateJobReason(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req jobReasonRequest
	if !decodeJSON(w, r, &req) {
		return "", false
	}
	if strings.TrimSpace(req.Reason) == "" {
		http.Error(w, `{"error":"reason is required"}`, http.StatusBadRequest)
		return "", false
	}
	if len(req.Reason) > 1000 {
		http.Error(w, `{"error":"reason cannot exceed 1000 characters"}`, http.StatusBadRequest)
		return "", false
	}
	return req.Reason, true
}

// CancelJob proxies POST /admin/jobs/{id}/cancel.
func (p *ReviewerProxy) CancelJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	id, ok := jobID(r)
	if !ok {
		http.Error(w, `{"error":"job id is required"}`, http.StatusBadRequest)
		return
	}
	reason, ok := validateJobReason(w, r)
	if !ok {
		return
	}

	payload, err := json.Marshal(jobReasonRequest{Reason: reason})
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.userServiceURL, "/admin/jobs/"+id+"/cancel")
}

// CompleteStuckCOD proxies POST /admin/jobs/{id}/complete-stuck-cod.
func (p *ReviewerProxy) CompleteStuckCOD(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	id, ok := jobID(r)
	if !ok {
		http.Error(w, `{"error":"job id is required"}`, http.StatusBadRequest)
		return
	}
	reason, ok := validateJobReason(w, r)
	if !ok {
		return
	}

	payload, err := json.Marshal(jobReasonRequest{Reason: reason})
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.userServiceURL, "/admin/jobs/"+id+"/complete-stuck-cod")
}

// Overview proxies GET /admin/overview to user-service (which aggregates the
// auth-service and chat-service internal overview stats itself). Figures for
// a backend that fails inside user-service arrive as the string
// "unavailable"; the upstream contract keeps the status at 200.
func (p *ReviewerProxy) Overview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	p.forwardToService(w, r, p.userServiceURL, "/admin/overview")
}

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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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

// Payouts proxies GET /admin/payouts to user-service.
func (p *ReviewerProxy) Payouts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/admin/payouts"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.userServiceURL, upstreamPath)
}

type rejectPayoutRequest struct {
	PayoutID string `json:"payout_id"`
	Reason   string `json:"reason"`
}

// RejectPayout proxies POST /admin/payouts/reject with mandatory reason validation.
func (p *ReviewerProxy) RejectPayout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req rejectPayoutRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.PayoutID) == "" {
		http.Error(w, `{"error":"payout_id is required"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
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
	p.forwardToService(w, r, p.userServiceURL, "/admin/payouts/reject")
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
	if !decodeJSON(w, r, &req) {
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

// Me returns the authenticated reviewer profile claims from auth-service.
// GET /auth/reviewer/verify
func (p *ReviewerProxy) Me(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	p.forwardToService(w, r, p.authServiceURL, "/auth/reviewer/verify")
}

type acceptTicketRequest struct {
	TicketID string `json:"ticket_id"`
}

// AcceptTicket proxies POST /admin/tickets/accept to chat-service.
func (p *ReviewerProxy) AcceptTicket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}

	var req acceptTicketRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.TicketID) == "" {
		http.Error(w, `{"error":"ticket_id is required"}`, http.StatusBadRequest)
		return
	}

	payload, err := json.Marshal(req)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	p.forwardToService(w, r, p.chatServiceURL, "/admin/tickets/accept")
}

// TicketsHistory proxies GET /chat/history to chat-service.
func (p *ReviewerProxy) TicketsHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	upstreamPath := "/chat/history"
	if r.URL.RawQuery != "" {
		upstreamPath += "?" + r.URL.RawQuery
	}
	p.forwardToService(w, r, p.chatServiceURL, upstreamPath)
}

// TicketAttachment proxies POST /chat/tickets/{id}/attachment to chat-service.
func (p *ReviewerProxy) TicketAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"use POST"}`, http.StatusMethodNotAllowed)
		return
	}
	ticketID := r.URL.Query().Get("ticket_id")
	if ticketID == "" {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		for i, part := range parts {
			if part == "tickets" && i+1 < len(parts) {
				candidate := parts[i+1]
				if candidate != "attachment" {
					ticketID = candidate
					break
				}
			}
		}
	}
	if ticketID == "" {
		http.Error(w, `{"error":"ticket_id is required"}`, http.StatusBadRequest)
		return
	}
	p.forwardMultipartToService(w, r, p.chatServiceURL, "/chat/tickets/"+url.PathEscape(ticketID)+"/attachment")
}

// AttachmentView proxies GET /chat/attachments/view?token=... to chat-service.
func (p *ReviewerProxy) AttachmentView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" || strings.ContainsAny(token, "&/#?") {
		http.Error(w, `{"error":"token is required"}`, http.StatusBadRequest)
		return
	}
	p.forwardToService(w, r, p.chatServiceURL, "/chat/attachments/view?token="+url.QueryEscape(token))
}

// wsAuthProtocol is the WebSocket subprotocol the browser offers first; the
// second offered value is the reviewer token. Browsers cannot set headers on
// a WebSocket handshake, and a token in the page URL leaks into history and
// access logs, so the token travels in Sec-WebSocket-Protocol instead.
const wsAuthProtocol = "kyc-console-auth"

// reviewerTokenFromSubprotocols extracts the token from
// "Sec-WebSocket-Protocol: kyc-console-auth, <token>".
func reviewerTokenFromSubprotocols(r *http.Request) string {
	var offered []string
	for _, h := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, v := range strings.Split(h, ",") {
			offered = append(offered, strings.TrimSpace(v))
		}
	}
	if len(offered) != 2 || offered[0] != wsAuthProtocol || offered[1] == "" {
		return ""
	}
	return offered[1]
}

// ChatWebSocket reverse-proxies WebSocket connections to chat-service.
//
// chat-service authenticates the socket only via GET /chat/ws?token=, so the
// token taken from the subprotocol is put on the upstream URL here, server
// side. Any other client-supplied query string is dropped.
//
// Deprecated fallback: a client that offers no subprotocol may still send
// ?token= (saas-core's e2e suite does, tests/e2e ConnectConsoleWS). The
// console UI never does; remove the fallback once that suite migrates.
func (p *ReviewerProxy) ChatWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"use GET"}`, http.StatusMethodNotAllowed)
		return
	}
	token := reviewerTokenFromSubprotocols(r)
	viaSubprotocol := token != ""
	if !viaSubprotocol && len(r.Header.Values("Sec-WebSocket-Protocol")) == 0 {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		http.Error(w, `{"error":"reviewer token required"}`, http.StatusUnauthorized)
		return
	}
	target, err := url.Parse(p.chatServiceURL)
	if err != nil {
		http.Error(w, `{"error":"invalid chat service URL"}`, http.StatusInternalServerError)
		return
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	if p.client != nil && p.client.Transport != nil {
		rp.Transport = p.client.Transport
	}
	origDirector := rp.Director
	rp.Director = func(req *http.Request) {
		origDirector(req)
		req.URL.Path = "/chat/ws"
		req.URL.RawPath = ""
		req.URL.RawQuery = url.Values{"token": {token}}.Encode()
		req.Host = target.Host
		req.Header.Del("Sec-WebSocket-Protocol")
	}
	rp.ModifyResponse = func(resp *http.Response) error {
		if viaSubprotocol && resp.StatusCode == http.StatusSwitchingProtocols {
			// The browser fails the handshake unless one offered protocol is echoed.
			resp.Header.Set("Sec-WebSocket-Protocol", wsAuthProtocol)
		}
		return nil
	}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		// #nosec G706 //nolint:gosec -- error text is unwrapped from *url.Error (no URL/token) and CR/LF-sanitized
		log.Printf("[CONSOLE] chat websocket upstream failed: %v", upstreamErrText(err))
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
	}
	rp.ServeHTTP(w, r)
}
