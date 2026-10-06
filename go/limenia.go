package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	maxAttempts = 5                // waits 1, 2, 4 and 8 seconds between attempts
	maxWait     = 30 * time.Second // a longer Retry-After is passed on instead
)

// Client is a tiny client for the Limenia ingest API (/v1).
type Client struct {
	BaseURL string // without /v1, e.g. https://app.limenia.eu
	APIKey  string
	HTTP    *http.Client
	// Sleep waits between attempts; tests replace it.
	Sleep func(ctx context.Context, d time.Duration) error
}

func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		// Limenia scales to zero; the first request after a pause can be slow.
		HTTP:  &http.Client{Timeout: 30 * time.Second},
		Sleep: sleep,
	}
}

// Do sends a request. With retry, network errors, 429 and 5xx are retried
// with exponential backoff, waiting at least Retry-After; the same body and
// headers (including Idempotency-Key) go out every time. The last response is
// returned as it is. The caller closes its body.
func (c *Client) Do(ctx context.Context, method, path string, body []byte, header http.Header, retry bool) (*http.Response, error) {
	backoff := time.Second
	for attempt := 1; ; attempt++ {
		last := !retry || attempt == maxAttempts
		req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		for k, v := range header {
			req.Header[k] = v
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := c.HTTP.Do(req)
		if err != nil {
			if last || ctx.Err() != nil {
				return nil, err
			}
			if err := c.Sleep(ctx, backoff); err != nil {
				return nil, err
			}
			backoff *= 2
			continue
		}
		if last || (resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500) {
			return resp, nil
		}
		wait := max(backoff, retryAfter(resp))
		if wait > maxWait {
			return resp, nil
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if err := c.Sleep(ctx, wait); err != nil {
			return nil, err
		}
		backoff *= 2
	}
}

func retryAfter(resp *http.Response) time.Duration {
	secs, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	if err != nil || secs < 0 {
		return 0
	}
	return time.Duration(secs) * time.Second
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DeviceRequestHash is base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)) without padding.
func DeviceRequestHash(externalUserID, nonce string) string {
	sum := sha256.Sum256([]byte("limenia:" + externalUserID + ":" + nonce))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
