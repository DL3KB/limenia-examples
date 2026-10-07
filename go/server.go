package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// requestHashTTL: Limenia rejects device tokens older than 15 minutes.
const requestHashTTL = 10 * time.Minute

// reportFields are the fields the app may set in a report. source and
// reporter are set by the backend.
var reportFields = []string{"reasonCategory", "reasonText", "goodFaith", "subject", "content", "externalReportId"}

type Server struct {
	limenia   *Client
	secrets   []string // current webhook secret, plus the previous one while rotating
	actions   Actions
	processed *processedEvents

	mu     sync.Mutex
	hashes map[string]pendingHash // user ID -> request hash; use your cache in production
}

type pendingHash struct {
	hash    string
	expires time.Time
}

func NewServer(c *Client, actions Actions, secrets ...string) *Server {
	return &Server{
		limenia:   c,
		secrets:   secrets,
		actions:   actions,
		processed: &processedEvents{ids: map[string]bool{}},
		hashes:    map[string]pendingHash{},
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /reports", s.withUser(s.createReport))
	mux.HandleFunc("GET /me/moderation-status", s.withUser(s.myStatus))
	mux.HandleFunc("POST /devices/request-hash", s.withUser(s.deviceRequestHash))
	mux.HandleFunc("POST /devices/check", s.withUser(s.deviceCheck))
	mux.HandleFunc("POST /limenia/webhook", s.handleWebhook)
	return mux
}

// currentUser: REPLACE WITH YOUR LOGIN. This stub trusts an X-User-Id
// header so the example runs without an auth system. Return the stable
// internal ID of the signed-in user (the same ID you use as externalUserId).
func currentUser(r *http.Request) (string, bool) {
	id := r.Header.Get("X-User-Id")
	return id, id != ""
}

func (s *Server) withUser(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := currentUser(r)
		if !ok {
			writeProblem(w, http.StatusUnauthorized, "unauthenticated", "Not signed in")
			return
		}
		h(w, r, userID)
	}
}

func (s *Server) createReport(w http.ResponseWriter, r *http.Request, userID string) {
	var in map[string]json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil || in == nil {
		writeProblem(w, http.StatusBadRequest, "bad_request", "Body must be a JSON object")
		return
	}
	report := map[string]any{}
	for _, k := range reportFields {
		if v, ok := in[k]; ok {
			report[k] = v
		}
	}
	report["source"] = "user"
	report["reporter"] = map[string]string{"externalUserId": userID} // from the login, never from the body
	body, _ := json.Marshal(report)

	// The app should create one key per report and resend it on every retry.
	// Without one, generate it here; it then only covers our own retries.
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		key = "report-" + randomHex(16)
	}
	resp, err := s.limenia.Do(r.Context(), http.MethodPost, "/v1/reports", body,
		http.Header{"Idempotency-Key": {key}}, true)
	if err != nil {
		writeProblem(w, http.StatusBadGateway, "limenia_unreachable", "Limenia could not be reached")
		return
	}
	w.Header().Set("Idempotency-Key", key)
	forward(w, resp)
}

func (s *Server) myStatus(w http.ResponseWriter, r *http.Request, userID string) {
	resp, err := s.limenia.Do(r.Context(), http.MethodGet,
		"/v1/subjects/"+url.PathEscape(userID)+"/status", nil, nil, true)
	if err != nil {
		writeProblem(w, http.StatusBadGateway, "limenia_unreachable", "Limenia could not be reached")
		return
	}
	forward(w, resp)
}

// deviceRequestHash is step 1 of a device check: the app passes the hash to
// LimeniaDevice.requestToken (Flutter plugin limenia_device).
func (s *Server) deviceRequestHash(w http.ResponseWriter, _ *http.Request, userID string) {
	hash := DeviceRequestHash(userID, randomHex(24))
	s.mu.Lock()
	s.hashes[userID] = pendingHash{hash: hash, expires: time.Now().Add(requestHashTTL)}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"requestHash": hash})
}

type deviceCheckRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Platform       string `json:"platform"` // android, ios or test
	Token          string `json:"token"`
	RequestHash    string `json:"requestHash,omitempty"` // Android only
	Environment    string `json:"environment,omitempty"` // iOS only: production or development
	Event          string `json:"event,omitempty"`       // registration, login, report or other
}

// deviceCheck is step 2: the app sends {platform, token[, event, environment]}.
// Call it at registration and at every login, also for a banned account
// before you reject the login.
func (s *Server) deviceCheck(w http.ResponseWriter, r *http.Request, userID string) {
	var check deviceCheckRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&check); err != nil {
		writeProblem(w, http.StatusBadRequest, "bad_request", "Body must be a JSON object")
		return
	}
	check.ExternalUserID = userID // from the login, never from the body
	check.RequestHash = ""
	s.mu.Lock()
	pending, ok := s.hashes[userID]
	delete(s.hashes, userID) // single use
	s.mu.Unlock()
	if check.Platform == "android" {
		if !ok || time.Now().After(pending.expires) {
			writeProblem(w, http.StatusBadRequest, "request_hash_missing", "Request a hash first")
			return
		}
		check.RequestHash = pending.hash
	}
	body, _ := json.Marshal(check)

	// No retries: a device token is single-use.
	resp, err := s.limenia.Do(r.Context(), http.MethodPost, "/v1/devices/check", body, nil, false)
	if err == nil && resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500 {
		// 200: see the README for how to use status, deviceFlag and subject.status.
		forward(w, resp)
		return
	}
	if resp != nil {
		resp.Body.Close()
	}
	// Fail open. Never reject a login because the check could not run.
	writeJSON(w, http.StatusOK, map[string]string{"status": "unevaluated", "deviceFlag": "unknown"})
}

// forward passes Limenia's status, body (JSON or problem+json) and
// Retry-After on to the app.
func forward(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Retry-After"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		slog.Warn("forwarding response failed", "err", err)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeProblem(w http.ResponseWriter, status int, code, title string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": title, "status": status, "code": code})
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
