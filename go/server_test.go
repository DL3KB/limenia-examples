package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeLimenia answers requests of the client with queued responses.
type fakeLimenia struct {
	responses []func() (*http.Response, error)
	requests  []*http.Request
	bodies    []string
}

func (f *fakeLimenia) RoundTrip(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	f.requests = append(f.requests, r)
	f.bodies = append(f.bodies, string(b))
	next := f.responses[0]
	f.responses = f.responses[1:]
	return next()
}

func respond(status int, header http.Header, body string) func() (*http.Response, error) {
	return func() (*http.Response, error) {
		if header == nil {
			header = http.Header{}
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
}

func networkError() (*http.Response, error) { return nil, errors.New("connection refused") }

// recorder records which actions were called.
type recorder struct{ calls []string }

func (r *recorder) add(s string) error { r.calls = append(r.calls, s); return nil }
func (r *recorder) RemoveContent(_ context.Context, id string) error {
	return r.add("RemoveContent " + id)
}
func (r *recorder) RestrictContent(_ context.Context, id string) error {
	return r.add("RestrictContent " + id)
}
func (r *recorder) RestoreContent(_ context.Context, id string) error {
	return r.add("RestoreContent " + id)
}
func (r *recorder) RejectSubmission(_ context.Context, id string) error {
	return r.add("RejectSubmission " + id)
}
func (r *recorder) PublishSubmission(_ context.Context, rv *Review) error {
	return r.add("PublishSubmission " + rv.ID)
}
func (r *recorder) WarnUser(_ context.Context, id, _ string) error { return r.add("WarnUser " + id) }
func (r *recorder) SuspendUser(_ context.Context, id string, _ time.Time) error {
	return r.add("SuspendUser " + id)
}
func (r *recorder) BanUser(_ context.Context, id string) error { return r.add("BanUser " + id) }
func (r *recorder) RestoreAccount(_ context.Context, id string) error {
	return r.add("RestoreAccount " + id)
}
func (r *recorder) SetAccountStatus(_ context.Context, s *SubjectStatus) error {
	return r.add("SetAccountStatus " + s.ExternalUserID)
}
func (r *recorder) NotifyAppellant(_ context.Context, a *Appeal) error {
	return r.add("NotifyAppellant " + a.ID)
}
func (r *recorder) NotifyReporters(_ context.Context, rr *ReportsResolved) error {
	return r.add("NotifyReporters " + rr.DecisionID)
}

type harness struct {
	handler http.Handler
	fake    *fakeLimenia
	waits   []time.Duration
	actions *recorder
}

func newHarness(responses ...func() (*http.Response, error)) *harness {
	h := &harness{fake: &fakeLimenia{responses: responses}, actions: &recorder{}}
	c := NewClient("https://limenia.test/", "lm_test")
	c.HTTP = &http.Client{Transport: h.fake}
	c.Sleep = func(_ context.Context, d time.Duration) error { h.waits = append(h.waits, d); return nil }
	h.handler = NewServer(c, h.actions, "whsec_new", testSecret).Routes()
	return h
}

func (h *harness) do(method, path, body string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

const created = `{"reportId":"r1","caseId":"c1","caseCreated":true}`

func TestReportSetsReporterAndPassesKey(t *testing.T) {
	h := newHarness(respond(201, nil, created))
	rec := h.do("POST", "/reports",
		`{"reasonCategory":"spam","source":"system","reporter":{"externalUserId":"someone_else"},"content":{"externalContentId":"c_1","contentType":"comment"}}`,
		map[string]string{"X-User-Id": "u_1", "Idempotency-Key": "report-42"})

	if rec.Code != 201 || rec.Body.String() != created {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	req := h.fake.requests[0]
	if req.URL.String() != "https://limenia.test/v1/reports" || req.Header.Get("Authorization") != "Bearer lm_test" || req.Header.Get("Idempotency-Key") != "report-42" {
		t.Fatalf("unexpected request %s %v", req.URL, req.Header)
	}
	var sent map[string]any
	json.Unmarshal([]byte(h.fake.bodies[0]), &sent)
	if sent["source"] != "user" || !reflect.DeepEqual(sent["reporter"], map[string]any{"externalUserId": "u_1"}) {
		t.Fatalf("unexpected body %v", sent)
	}
}

func TestReportRequiresLogin(t *testing.T) {
	h := newHarness()
	if rec := h.do("POST", "/reports", `{}`, nil); rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestReportRetriesWithSameKeyAndRespectsRetryAfter(t *testing.T) {
	h := newHarness(
		networkError,
		respond(429, http.Header{"Retry-After": {"5"}}, `{"code":"rate_limited"}`),
		respond(503, nil, ""),
		respond(201, nil, created),
	)
	rec := h.do("POST", "/reports", `{"reasonCategory":"spam"}`, map[string]string{"X-User-Id": "u_1"})

	if rec.Code != 201 {
		t.Fatalf("got %d", rec.Code)
	}
	if want := []time.Duration{time.Second, 5 * time.Second, 4 * time.Second}; !reflect.DeepEqual(h.waits, want) {
		t.Fatalf("waits %v, want %v", h.waits, want)
	}
	key := h.fake.requests[0].Header.Get("Idempotency-Key")
	for i, r := range h.fake.requests {
		if r.Header.Get("Idempotency-Key") != key || h.fake.bodies[i] != h.fake.bodies[0] {
			t.Fatal("retries must send the same key and body")
		}
	}
	if !strings.HasPrefix(key, "report-") || rec.Header().Get("Idempotency-Key") != key {
		t.Fatalf("unexpected key %q", key)
	}
}

func TestReportForwardsProblemAndRetryAfter(t *testing.T) {
	problem := `{"type":"about:blank","title":"Too Many Requests","status":429,"code":"rate_limited"}`
	h := newHarness(respond(429, http.Header{"Retry-After": {"120"}, "Content-Type": {"application/problem+json"}}, problem))
	rec := h.do("POST", "/reports", `{"reasonCategory":"spam"}`, map[string]string{"X-User-Id": "u_1"})

	if rec.Code != 429 || rec.Header().Get("Retry-After") != "120" ||
		rec.Header().Get("Content-Type") != "application/problem+json" || rec.Body.String() != problem {
		t.Fatalf("got %d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	if len(h.waits) != 0 {
		t.Fatalf("should not wait 120 s, waited %v", h.waits)
	}
}

func TestReportDoesNotRetry4xx(t *testing.T) {
	h := newHarness(respond(400, nil, `{"code":"validation_failed"}`))
	if rec := h.do("POST", "/reports", `{"reasonCategory":"x"}`, map[string]string{"X-User-Id": "u_1"}); rec.Code != 400 {
		t.Fatalf("got %d", rec.Code)
	}
	if len(h.fake.requests) != 1 {
		t.Fatalf("sent %d requests", len(h.fake.requests))
	}
}

func TestStatusEncodesTheUserID(t *testing.T) {
	h := newHarness(respond(200, nil, `{"externalUserId":"a/b c","status":"active"}`))
	rec := h.do("GET", "/me/moderation-status", "", map[string]string{"X-User-Id": "a/b c"})
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	if got := h.fake.requests[0].URL.EscapedPath(); got != "/v1/subjects/a%2Fb%20c/status" {
		t.Fatalf("path %s", got)
	}
}

func TestDeviceCheckForwardsTokenAndHash(t *testing.T) {
	result := `{"checkId":"k1","platform":"android","status":"evaluated","deviceFlag":"none","deviceAction":"none","subject":{"externalUserId":"u_1","status":"active"},"test":false}`
	h := newHarness(respond(200, nil, result))
	user := map[string]string{"X-User-Id": "u_1"}
	var issued struct{ RequestHash string }
	json.Unmarshal(h.do("POST", "/devices/request-hash", "", user).Body.Bytes(), &issued)

	rec := h.do("POST", "/devices/check", `{"platform":"android","token":"tok","event":"login","externalUserId":"other"}`, user)

	if rec.Code != 200 || rec.Body.String() != result {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	want := `{"externalUserId":"u_1","platform":"android","token":"tok","requestHash":"` + issued.RequestHash + `","event":"login"}`
	if h.fake.bodies[0] != want {
		t.Fatalf("sent %s, want %s", h.fake.bodies[0], want)
	}
}

func TestDeviceCheckFailsOpenWithoutRetry(t *testing.T) {
	h := newHarness(respond(503, nil, ""))
	rec := h.do("POST", "/devices/check", `{"platform":"ios","token":"tok"}`, map[string]string{"X-User-Id": "u_1"})
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"deviceFlag":"unknown","status":"unevaluated"}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if len(h.fake.requests) != 1 {
		t.Fatalf("sent %d requests", len(h.fake.requests))
	}
}

func (h *harness) postEvent(event, secret string) int {
	sig := Sign([]byte(event), secret, time.Now().Unix())
	return h.do("POST", "/limenia/webhook", event, map[string]string{"Limenia-Signature": sig}).Code
}

func decisionEvent(id, decision string) string {
	return `{"id":"` + id + `","type":"decision.created","createdAt":"2026-10-01T10:00:00Z","app":{"id":"a1","slug":"demo"},` +
		`"decision":{"id":"d1","policies":[],"decidedAt":"2026-10-01T10:00:00Z","statementOfReasons":{"locale":"en","text":"..."},` + decision + `}}`
}

func TestWebhookAppliesDecisionOnce(t *testing.T) {
	h := newHarness()
	ev := decisionEvent("evt_1", `"action":"ban_user","subject":{"externalUserId":"u_9"}`)
	if h.postEvent(ev, testSecret) != 204 || h.postEvent(ev, testSecret) != 204 {
		t.Fatal("expected 204 twice")
	}
	if !reflect.DeepEqual(h.actions.calls, []string{"BanUser u_9"}) {
		t.Fatalf("calls %v", h.actions.calls)
	}
}

func TestWebhookReviewDecisionNeverTouchesTheAccount(t *testing.T) {
	h := newHarness()
	ref := `"content":{"externalContentId":"photo_1"},"subject":{"externalUserId":"u_9"},"reviewId":"rv1"`
	h.postEvent(decisionEvent("evt_2", `"action":"reject_submission",`+ref), testSecret)
	h.postEvent(decisionEvent("evt_3", `"action":"restore","restoreScope":"content",`+ref), testSecret)
	if want := []string{"RejectSubmission photo_1", "RestoreContent photo_1"}; !reflect.DeepEqual(h.actions.calls, want) {
		t.Fatalf("calls %v, want %v", h.actions.calls, want)
	}
}

func TestWebhookRestoreAccount(t *testing.T) {
	h := newHarness()
	h.postEvent(decisionEvent("evt_4", `"action":"restore","restoreScope":"account","subject":{"externalUserId":"u_9"}`), testSecret)
	if !reflect.DeepEqual(h.actions.calls, []string{"RestoreAccount u_9"}) {
		t.Fatalf("calls %v", h.actions.calls)
	}
}

func TestWebhookRejectsBadSignature(t *testing.T) {
	h := newHarness()
	if code := h.postEvent(`{"id":"evt_5","type":"test.ping"}`, "whsec_wrong"); code != 401 {
		t.Fatalf("got %d", code)
	}
}

func TestWebhookAcknowledgesOtherEvents(t *testing.T) {
	h := newHarness()
	events := []string{
		`{"id":"evt_6","type":"something.new"}`,
		`{"id":"evt_7","type":"test.ping"}`,
		`{"id":"evt_8","type":"subject.status_changed","subject":{"externalUserId":"u_9","status":"active"}}`,
		`{"id":"evt_9","type":"appeal.resolved","appeal":{"id":"ap1","decisionId":"d1","outcome":"upheld","statementText":"..."}}`,
		`{"id":"evt_10","type":"reports.resolved","reports":{"decisionId":"d1","items":[{"reportId":"r1"}]}}`,
		`{"id":"evt_11","type":"review.decided","review":{"id":"rv2","type":"profile_photo","outcome":"approved"}}`,
	}
	for _, ev := range events {
		if code := h.postEvent(ev, testSecret); code != 204 {
			t.Fatalf("%s: got %d", ev, code)
		}
	}
	want := []string{"SetAccountStatus u_9", "NotifyAppellant ap1", "NotifyReporters d1", "PublishSubmission rv2"}
	if !reflect.DeepEqual(h.actions.calls, want) {
		t.Fatalf("calls %v, want %v", h.actions.calls, want)
	}
}
