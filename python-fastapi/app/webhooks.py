"""What to do with each Limenia webhook event.

Every function marked TODO is a placeholder for your own code. Make them
idempotent: set a state instead of toggling it, because an event can arrive
more than once and events can arrive out of order. To guard against order,
remember per user and per content the time of the last change you applied
(`decision.decidedAt`, or `createdAt` of `subject.status_changed`) and skip
older events.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("limenia.webhooks")

Event = dict[str, Any]


class ProcessedEvents:
    """Remembers handled event IDs. In memory for this example: use a table
    with a unique key on the event ID (or Redis) in production."""

    def __init__(self) -> None:
        self._ids: set[str] = set()

    def seen(self, event_id: str) -> bool:
        return event_id in self._ids

    def add(self, event_id: str) -> None:
        self._ids.add(event_id)


async def handle_event(event: Event) -> None:
    """Apply one verified event. Raise to make Limenia retry later."""
    event_type = event.get("type")
    if event_type == "decision.created":
        apply_decision(event["decision"])
    elif event_type == "subject.status_changed":
        subject = event["subject"]
        set_account_status(subject["externalUserId"], subject["status"], subject.get("suspendedUntil"))
    elif event_type == "appeal.resolved":
        notify_appellant(event["appeal"])
    elif event_type == "reports.resolved":
        notify_reporters(event["reports"])
    elif event_type == "review.decided":
        apply_review_outcome(event["review"])
    elif event_type == "test.ping":
        log.info("limenia test.ping received", extra={"event_id": event.get("id")})
    else:
        # Unknown types are acknowledged (2xx) so Limenia does not retry them.
        log.info("ignoring unknown limenia event type", extra={"event_id": event.get("id")})


def apply_decision(decision: dict[str, Any]) -> None:
    action = decision["action"]
    content_id = (decision.get("content") or {}).get("externalContentId")
    user_id = (decision.get("subject") or {}).get("externalUserId")

    if decision.get("reviewId"):
        # A decision on a review request (pre-moderation) only concerns the
        # submitted content. Never change the account here.
        if action == "reject_submission":
            reject_submission(content_id)
        elif action == "restrict_content":
            restrict_content(content_id)  # publish it with restricted visibility
        elif action == "restore":
            restore_content(content_id)  # publish it as submitted
        else:
            log.warning("unsupported review decision", extra={"decision_id": decision["id"]})
        return

    if action == "dismiss":
        pass  # nothing to change; reporters learn the result via reports.resolved
    elif action == "remove_content":
        remove_content(content_id)
    elif action == "restrict_content":
        restrict_content(content_id)
    elif action == "warn_user":
        warn_user(user_id, decision["statementOfReasons"]["text"])
    elif action == "suspend_user":
        # Lift the suspension yourself at suspendUntil (UTC);
        # subject.status_changed can arrive up to about an hour later.
        suspend_user(user_id, decision["suspendUntil"])
    elif action == "ban_user":
        ban_user(user_id)
    elif action == "restore":
        if decision.get("restoreScope") == "account":
            restore_account(user_id)
        else:
            restore_content(content_id)
    elif action == "reject_submission":
        reject_submission(content_id)
    else:
        # Acknowledge anyway, otherwise Limenia retries for about 20 hours.
        log.warning("unsupported decision action", extra={"decision_id": decision["id"]})


def apply_review_outcome(review: dict[str, Any]) -> None:
    """`approved`: publish the submitted content. For `restricted` and
    `rejected` the decision follows as decision.created (with `reviewId`)."""
    if review["outcome"] == "approved":
        publish_submission(review["id"], review.get("externalReviewId"))


# --- Placeholders: replace with your own code. -------------------------------


def remove_content(external_content_id: str | None) -> None:
    log.info("TODO remove content", extra={"content_id": external_content_id})


def restrict_content(external_content_id: str | None) -> None:
    log.info("TODO restrict content", extra={"content_id": external_content_id})


def restore_content(external_content_id: str | None) -> None:
    log.info("TODO restore content", extra={"content_id": external_content_id})


def reject_submission(external_content_id: str | None) -> None:
    log.info("TODO do not publish submission", extra={"content_id": external_content_id})


def publish_submission(review_id: str, external_review_id: str | None) -> None:
    log.info("TODO publish approved submission", extra={"review_id": review_id})


def warn_user(external_user_id: str | None, statement_of_reasons: str) -> None:
    # Show the statement of reasons to the user; do not restrict the account.
    log.info("TODO warn user", extra={"user_id": external_user_id})


def suspend_user(external_user_id: str | None, suspend_until: str) -> None:
    log.info("TODO suspend user", extra={"user_id": external_user_id})


def ban_user(external_user_id: str | None) -> None:
    log.info("TODO ban user", extra={"user_id": external_user_id})


def restore_account(external_user_id: str | None) -> None:
    log.info("TODO re-enable account", extra={"user_id": external_user_id})


def set_account_status(external_user_id: str, status: str, suspended_until: str | None) -> None:
    # Currently sent when a temporary suspension ends.
    log.info("TODO set account status", extra={"user_id": external_user_id})


def notify_appellant(appeal: dict[str, Any]) -> None:
    # Show appeal["statementText"] to the person who appealed.
    log.info("TODO notify appellant", extra={"appeal_id": appeal["id"]})


def notify_reporters(reports: dict[str, Any]) -> None:
    # Tell each reporter (items[].reportId / externalReportId) the outcome.
    log.info("TODO notify reporters", extra={"decision_id": reports["decisionId"]})
