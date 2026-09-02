package config

import "testing"

// ADR-0021 / Q23 discipline: the console must refuse to start without the
// internal service secret. An empty INTERNAL_SERVICE_TOKEN would let every
// proxied request carry an empty internal token, which auth-service's
// authenticateReviewer correctly rejects — but fail-fast is still required so
// misconfiguration surfaces at deploy time, not at review time.
func TestLoad_EmptyInternalTokenFailsFast(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected Load to fail with empty INTERNAL_SERVICE_TOKEN, got nil error")
	}
}

func TestLoad_DefaultsAndExplicitValues(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", "secret-internal-token")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Port != "8090" {
		t.Errorf("expected default port 8090, got %q", cfg.Port)
	}
	if cfg.AuthServiceURL != "https://auth-service:3002" {
		t.Errorf("expected default auth-service URL, got %q", cfg.AuthServiceURL)
	}
	if cfg.UserServiceURL != "https://user-service:3003" {
		t.Errorf("expected default user-service URL, got %q", cfg.UserServiceURL)
	}
	if cfg.ChatServiceURL != "https://chat-service:3001" {
		t.Errorf("expected default chat-service URL, got %q", cfg.ChatServiceURL)
	}

	t.Setenv("PORT", "9999")
	t.Setenv("AUTH_SERVICE_URL", "https://auth-service.internal:3002")
	t.Setenv("USER_SERVICE_URL", "https://user-service.internal:3003")
	t.Setenv("CHAT_SERVICE_URL", "https://chat-service.internal:3001")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Port != "9999" || cfg.AuthServiceURL != "https://auth-service.internal:3002" || cfg.UserServiceURL != "https://user-service.internal:3003" || cfg.ChatServiceURL != "https://chat-service.internal:3001" {
		t.Errorf("explicit env values not honored: %+v", cfg)
	}
}
