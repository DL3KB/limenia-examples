package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Event is the body of every Limenia webhook request.
type Event struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"createdAt"`
	App       struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
	} `json:"app"`
	Decision *Decision        `json:"decision,omitempty"` // decision.created
	Subject  *SubjectStatus   `json:"subject,omitempty"`  // subject.status_changed
	Appeal   *Appeal          `json:"appeal,omitempty"`   // appeal.resolved
	Reports  *ReportsResolved `json:"reports,omitempty"`  // reports.resolved
	Review   *Review          `json:"review,omitempty"`   // review.decided
}

type Decision struct {
	ID           string     `json:"id"`
	Action       string     `json:"action"`
	SuspendUntil *time.Time `json:"suspendUntil,omitempty"`
	Content      *struct {
		ExternalContentID string `json:"externalContentId"`
	} `json:"content,omitempty"`
	Subject *struct {
		ExternalUserID string `json:"externalUserId"`
	} `json:"subject,omitempty"`
	Policies []struct {
		Code  string `json:"code"`
		Title string `json:"title"`
	} `json:"policies"`
	StatementOfReasons struct {
		Locale string `json:"locale"`
		Text   string `json:"text"` // show this to the affected user
	} `json:"statementOfReasons"`
	DecidedAt          time.Time `json:"decidedAt"`
	AppealID           string    `json:"appealId,omitempty"`
	ReplacesDecisionID string    `json:"replacesDecisionId,omitempty"`
	ReviewID           string    `json:"reviewId,omitempty"`
	RestoreScope       string    `json:"restoreScope,omitempty"` // content or account, only for restore
}

func (d *Decision) contentID() string {
	if d.Content == nil {
		return ""
	}
	return d.Content.ExternalContentID
}

func (d *Decision) userID() string {
	if d.Subject == nil {
		return ""
	}
	return d.Subject.ExternalUserID
}

type SubjectStatus struct {
	ExternalUserID string     `json:"externalUserId"`
	Status         string     `json:"status"` // active, warned, suspended, banned
	SuspendedUntil *time.Time `json:"suspendedUntil,omitempty"`
}

type Appeal struct {
	ID               string    `json:"id"`
	ExternalAppealID string    `json:"externalAppealId,omitempty"`
	DecisionID       string    `json:"decisionId"`
	AppellantType    string    `json:"appellantType"` // subject or reporter
	Outcome          string    `json:"outcome"`       // upheld or changed
	StatementText    string    `json:"statementText"` // show this to the appellant
	ResolvedAt       time.Time `json:"resolvedAt"`
	NewDecisionID    string    `json:"newDecisionId,omitempty"`
}

type ReportsResolved struct {
	DecisionID     string    `json:"decisionId"`
	Action         string    `json:"action"`
	DecidedAt      time.Time `json:"decidedAt"`
	AppealDeadline time.Time `json:"appealDeadline"`
	Items          []struct {
		ReportID         string `json:"reportId"`
		ExternalReportID string `json:"externalReportId,omitempty"`
	} `json:"items"`
}

type Review struct {
	ID               string    `json:"id"`
	ExternalReviewID string    `json:"externalReviewId,omitempty"`
	Type             string    `json:"type"`
	Outcome          string    `json:"outcome"` // approved, restricted or rejected
	DecidedAt        time.Time `json:"decidedAt"`
	DecisionID       string    `json:"decisionId,omitempty"`
}

// Actions is what your app does when Limenia decides. placeholderActions
// (actions.go) only logs; replace it with your own code. Make every method
// idempotent: set a state instead of toggling it, because events can arrive
// more than once and out of order. To guard against order, remember per user
// and per content the time of the last change you applied
// (Decision.DecidedAt, Event.CreatedAt of subject.status_changed) and skip
// older events.
type Actions interface {
	RemoveContent(ctx context.Context, contentID string) error
	RestrictContent(ctx context.Context, contentID string) error
	RestoreContent(ctx context.Context, contentID string) error
	RejectSubmission(ctx context.Context, contentID string) error
	PublishSubmission(ctx context.Context, review *Review) error
	WarnUser(ctx context.Context, userID, statement string) error
	SuspendUser(ctx context.Context, userID string, until time.Time) error
	BanUser(ctx context.Context, userID string) error
	RestoreAccount(ctx context.Context, userID string) error
	SetAccountStatus(ctx context.Context, status *SubjectStatus) error
	NotifyAppellant(ctx context.Context, appeal *Appeal) error
	NotifyReporters(ctx context.Context, reports *ReportsResolved) error
}

// processedEvents remembers handled event IDs. In memory for this example:
// use a table with a unique key on the event ID (or Redis) in production.
type processedEvents struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (p *processedEvents) seen(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ids[id]
}

func (p *processedEvents) add(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ids[id] = true
}

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20)) // the raw bytes, exactly as signed
	if err != nil {
		http.Error(w, "cannot read body", http.StatusBadRequest)
		return
	}
	if err := VerifySignature(r.Header.Get("Limenia-Signature"), body, time.Now(), s.secrets...); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": err.Error()})
		return
	}
	var ev Event
	if err := json.Unmarshal(body, &ev); err != nil || ev.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_body"})
		return
	}
	if s.processed.seen(ev.ID) {
		w.WriteHeader(http.StatusNoContent) // duplicate: acknowledge only
		return
	}
	if err := s.handleEvent(r.Context(), &ev); err != nil {
		slog.Error("limenia event failed", "eventId", ev.ID, "err", err)
		w.WriteHeader(http.StatusServiceUnavailable) // Limenia retries later
		return
	}
	s.processed.add(ev.ID)
	w.WriteHeader(http.StatusNoContent)
}

var errMissingPayload = errors.New("event without payload")

func (s *Server) handleEvent(ctx context.Context, ev *Event) error {
	a := s.actions
	switch ev.Type {
	case "decision.created":
		if ev.Decision == nil {
			return errMissingPayload
		}
		return applyDecision(ctx, a, ev.Decision)
	case "subject.status_changed":
		if ev.Subject == nil {
			return errMissingPayload
		}
		return a.SetAccountStatus(ctx, ev.Subject)
	case "appeal.resolved":
		if ev.Appeal == nil {
			return errMissingPayload
		}
		return a.NotifyAppellant(ctx, ev.Appeal)
	case "reports.resolved":
		if ev.Reports == nil {
			return errMissingPayload
		}
		return a.NotifyReporters(ctx, ev.Reports)
	case "review.decided":
		// approved: publish. restricted and rejected: the decision follows
		// as decision.created with reviewId.
		if ev.Review != nil && ev.Review.Outcome == "approved" {
			return a.PublishSubmission(ctx, ev.Review)
		}
		return nil
	case "test.ping":
		slog.Info("limenia test.ping received", "eventId", ev.ID)
		return nil
	default:
		// Unknown types are acknowledged (2xx) so Limenia does not retry them.
		slog.Info("ignoring unknown limenia event type", "eventId", ev.ID)
		return nil
	}
}

func applyDecision(ctx context.Context, a Actions, d *Decision) error {
	if d.ReviewID != "" {
		// A decision on a review request (pre-moderation) only concerns the
		// submitted content. Never change the account here.
		switch d.Action {
		case "reject_submission":
			return a.RejectSubmission(ctx, d.contentID())
		case "restrict_content":
			return a.RestrictContent(ctx, d.contentID()) // publish it with restricted visibility
		case "restore":
			return a.RestoreContent(ctx, d.contentID()) // publish it as submitted
		}
		slog.Warn("unsupported review decision", "decisionId", d.ID)
		return nil
	}

	switch d.Action {
	case "dismiss":
		return nil // nothing to change; reporters learn the result via reports.resolved
	case "remove_content":
		return a.RemoveContent(ctx, d.contentID())
	case "restrict_content":
		return a.RestrictContent(ctx, d.contentID())
	case "warn_user":
		return a.WarnUser(ctx, d.userID(), d.StatementOfReasons.Text)
	case "suspend_user":
		if d.SuspendUntil == nil {
			return errMissingPayload
		}
		// Lift the suspension yourself at SuspendUntil (UTC);
		// subject.status_changed can arrive up to about an hour later.
		return a.SuspendUser(ctx, d.userID(), *d.SuspendUntil)
	case "ban_user":
		return a.BanUser(ctx, d.userID())
	case "restore":
		if d.RestoreScope == "account" {
			return a.RestoreAccount(ctx, d.userID())
		}
		return a.RestoreContent(ctx, d.contentID())
	case "reject_submission":
		return a.RejectSubmission(ctx, d.contentID())
	}
	// Acknowledge anyway, otherwise Limenia retries for about 20 hours.
	slog.Warn("unsupported decision action", "decisionId", d.ID)
	return nil
}
