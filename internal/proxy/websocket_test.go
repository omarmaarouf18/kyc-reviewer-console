package proxy

import (
	"bufio"
	"bytes"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeChatService answers /chat/ws with a bare 101 and records what it saw.
type fakeChatService struct {
	gotQuery    string
	gotProtocol string
	calls       int
}

func (f *fakeChatService) handler(w http.ResponseWriter, r *http.Request) {
	f.calls++
	f.gotQuery = r.URL.RawQuery
	f.gotProtocol = r.Header.Get("Sec-WebSocket-Protocol")
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n")
	_ = buf.Flush()
}

// handshake sends a raw WebSocket upgrade through the console proxy.
func handshake(t *testing.T, consoleURL, path, protocols string) *http.Response {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(consoleURL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	req := "GET " + path + " HTTP/1.1\r\nHost: console.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
	if protocols != "" {
		req += "Sec-WebSocket-Protocol: " + protocols + "\r\n"
	}
	if _, err := conn.Write([]byte(req + "\r\n")); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestChatWebSocket_TokenFromSubprotocolNotURL(t *testing.T) {
	chat := &fakeChatService{}
	upstream := httptest.NewServer(http.HandlerFunc(chat.handler))
	defer upstream.Close()
	p := NewWithServices("internal-test", upstream.URL, upstream.URL, upstream.URL, upstream.Client())
	console := httptest.NewServer(http.HandlerFunc(p.ChatWebSocket))
	defer console.Close()

	resp := handshake(t, console.URL, "/api/chat/ws", "kyc-console-auth, 0123abcd")
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "kyc-console-auth" {
		t.Errorf("echoed protocol = %q, want kyc-console-auth (browsers fail the handshake otherwise)", got)
	}
	if chat.gotQuery != "token=0123abcd" {
		t.Errorf("upstream query = %q, want token=0123abcd", chat.gotQuery)
	}
	if chat.gotProtocol != "" {
		t.Errorf("token must not be forwarded in Sec-WebSocket-Protocol, got %q", chat.gotProtocol)
	}
}

func TestChatWebSocket_RejectsMissingToken_LegacyQueryFallback(t *testing.T) {
	chat := &fakeChatService{}
	upstream := httptest.NewServer(http.HandlerFunc(chat.handler))
	defer upstream.Close()
	p := NewWithServices("internal-test", upstream.URL, upstream.URL, upstream.URL, upstream.Client())
	console := httptest.NewServer(http.HandlerFunc(p.ChatWebSocket))
	defer console.Close()

	for name, tc := range map[string]struct{ path, protocols string }{
		"no token":                      {"/api/chat/ws", ""},
		"query token with bad protocol": {"/api/chat/ws?token=0123abcd", "chat"},
		"wrong protocol name":           {"/api/chat/ws", "chat, 0123abcd"},
		"protocol name only":            {"/api/chat/ws", "kyc-console-auth"},
	} {
		if resp := handshake(t, console.URL, tc.path, tc.protocols); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401", name, resp.StatusCode)
		}
	}
	if chat.calls != 0 {
		t.Errorf("upstream called %d times for unauthenticated handshakes", chat.calls)
	}

	// Deprecated non-browser fallback (saas-core e2e): ?token= with no
	// subprotocol offered still works, and no protocol is echoed.
	resp := handshake(t, console.URL, "/api/chat/ws?token=legacy01&x=1", "")
	if resp.StatusCode != http.StatusSwitchingProtocols || chat.gotQuery != "token=legacy01" || resp.Header.Get("Sec-WebSocket-Protocol") != "" {
		t.Errorf("legacy query: got %d, upstream query %q, protocol %q", resp.StatusCode, chat.gotQuery, resp.Header.Get("Sec-WebSocket-Protocol"))
	}

	// A client query string never reaches chat-service alongside the real token.
	resp = handshake(t, console.URL, "/api/chat/ws?token=attacker&x=1", "kyc-console-auth, 0123abcd")
	if resp.StatusCode != http.StatusSwitchingProtocols || chat.gotQuery != "token=0123abcd" {
		t.Errorf("got %d with upstream query %q", resp.StatusCode, chat.gotQuery)
	}
}

func TestUpstreamFailureLogs_NeverContainTokens(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	p := NewWithServices("internal-test", deadURL, deadURL, deadURL, nil)

	console := httptest.NewServer(http.HandlerFunc(p.ChatWebSocket))
	defer console.Close()
	if resp := handshake(t, console.URL, "/api/chat/ws", "kyc-console-auth, wsSecret123"); resp.StatusCode != http.StatusBadGateway {
		t.Errorf("ws: status = %d, want 502", resp.StatusCode)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/documents/view?token=viewSecret456", nil)
	req.Header.Set("X-Reviewer-Token", "rev")
	rec := httptest.NewRecorder()
	p.DocumentView(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("document: status = %d, want 502", rec.Code)
	}

	logs := buf.String()
	if !strings.Contains(logs, "upstream") {
		t.Fatalf("expected upstream failure logs, got %q", logs)
	}
	for _, secret := range []string{"wsSecret123", "viewSecret456", "token="} {
		if strings.Contains(logs, secret) {
			t.Errorf("log leaks %q: %s", secret, logs)
		}
	}
}
