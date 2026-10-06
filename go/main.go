// Command server is a small backend of an app that uses Limenia for reports
// and moderation, with the Go standard library only.
package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"
)

func main() {
	baseURL := getenv("LIMENIA_BASE_URL", "https://app.limenia.eu")
	apiKey := os.Getenv("LIMENIA_API_KEY")
	secret := os.Getenv("LIMENIA_WEBHOOK_SECRET")
	if apiKey == "" || secret == "" {
		slog.Error("LIMENIA_API_KEY and LIMENIA_WEBHOOK_SECRET are required")
		os.Exit(1)
	}
	secrets := []string{secret}
	if previous := os.Getenv("LIMENIA_WEBHOOK_SECRET_PREVIOUS"); previous != "" {
		secrets = append(secrets, previous) // only while rotating
	}

	srv := NewServer(NewClient(baseURL, apiKey), placeholderActions{}, secrets...)
	addr := ":" + getenv("PORT", "8080")
	slog.Info("listening", "addr", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
