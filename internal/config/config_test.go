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

	t.Setenv("PORT", "9999")
	t.Setenv("AUTH_SERVICE_URL", "https://auth-service.internal:3002")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Port != "9999" || cfg.AuthServiceURL != "https://auth-service.internal:3002" {
		t.Errorf("explicit env values not honored: %+v", cfg)
	}
}
