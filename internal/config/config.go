// Package config loads the reviewer console's runtime configuration.
//
// Per ADR-0021 (saas-core), the console lives inside the internal network and
// is the component that holds INTERNAL_SERVICE_TOKEN: the api-gateway strips
// X-Internal-Token from all inbound client requests, so no external client can
// reach auth-service reviewer endpoints directly. An empty internal token is a
// hard startup failure — the console must never start unauthenticated.
package config

import (
	"errors"
	"os"
)

type Config struct {
	Port                 string
	InternalServiceToken string
	AuthServiceURL       string
	UserServiceURL       string
	TLSCertPath          string
	TLSKeyPath           string
	TLSCAPath            string
	AppEnv               string
}

func Load() (*Config, error) {
	internalServiceToken := os.Getenv("INTERNAL_SERVICE_TOKEN")
	if internalServiceToken == "" {
		// Empty-secret guard (Q23 discipline): never run without the secret.
		return nil, errors.New("config: required env var INTERNAL_SERVICE_TOKEN is empty")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}

	authServiceURL := os.Getenv("AUTH_SERVICE_URL")
	if authServiceURL == "" {
		authServiceURL = "https://auth-service:3002"
	}

	userServiceURL := os.Getenv("USER_SERVICE_URL")
	if userServiceURL == "" {
		userServiceURL = "https://user-service:3003"
	}

	appEnv := os.Getenv("APP_ENV")
	if appEnv == "" {
		appEnv = "production"
	}

	return &Config{
		Port:                 port,
		InternalServiceToken: internalServiceToken,
		AuthServiceURL:       authServiceURL,
		UserServiceURL:       userServiceURL,
		TLSCertPath:          os.Getenv("TLS_CERT_PATH"),
		TLSKeyPath:           os.Getenv("TLS_KEY_PATH"),
		TLSCAPath:            os.Getenv("TLS_CA_PATH"),
		AppEnv:               appEnv,
	}, nil
}
