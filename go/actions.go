package main

import (
	"context"
	"log/slog"
	"time"
)

// placeholderActions only logs. Replace every method with your own code.
// Log IDs only, never texts of users.
type placeholderActions struct{}

func todo(what string, args ...any) error {
	slog.Info("TODO "+what, args...)
	return nil
}

func (placeholderActions) RemoveContent(_ context.Context, contentID string) error {
	return todo("remove content", "contentId", contentID)
}

func (placeholderActions) RestrictContent(_ context.Context, contentID string) error {
	return todo("restrict content", "contentId", contentID)
}

func (placeholderActions) RestoreContent(_ context.Context, contentID string) error {
	return todo("restore content", "contentId", contentID)
}

func (placeholderActions) RejectSubmission(_ context.Context, contentID string) error {
	return todo("do not publish submission", "contentId", contentID)
}

func (placeholderActions) PublishSubmission(_ context.Context, review *Review) error {
	return todo("publish approved submission", "reviewId", review.ID)
}

func (placeholderActions) WarnUser(_ context.Context, userID, _ string) error {
	// Show the statement of reasons to the user; do not restrict the account.
	return todo("warn user", "userId", userID)
}

func (placeholderActions) SuspendUser(_ context.Context, userID string, until time.Time) error {
	return todo("suspend user", "userId", userID, "until", until)
}

func (placeholderActions) BanUser(_ context.Context, userID string) error {
	return todo("ban user", "userId", userID)
}

func (placeholderActions) RestoreAccount(_ context.Context, userID string) error {
	return todo("re-enable account", "userId", userID)
}

func (placeholderActions) SetAccountStatus(_ context.Context, s *SubjectStatus) error {
	// Currently sent when a temporary suspension ends.
	return todo("set account status", "userId", s.ExternalUserID, "status", s.Status)
}

func (placeholderActions) NotifyAppellant(_ context.Context, a *Appeal) error {
	// Show a.StatementText to the person who appealed.
	return todo("notify appellant", "appealId", a.ID)
}

func (placeholderActions) NotifyReporters(_ context.Context, r *ReportsResolved) error {
	// Tell each reporter (Items[].ReportID / ExternalReportID) the outcome.
	return todo("notify reporters", "decisionId", r.DecisionID)
}
