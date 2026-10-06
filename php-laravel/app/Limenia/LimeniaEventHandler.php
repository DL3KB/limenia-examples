<?php

declare(strict_types=1);

namespace App\Limenia;

use Illuminate\Support\Facades\Log;

/**
 * What to do with each verified Limenia webhook event.
 *
 * Every method marked TODO is a placeholder for your own code. Make them
 * idempotent: set a state instead of toggling it, because an event can arrive
 * more than once and events can arrive out of order. To guard against order,
 * remember per user and per content the time of the last change you applied
 * (decision.decidedAt, or createdAt of subject.status_changed) and skip older
 * events. Log IDs only, never texts of users.
 */
class LimeniaEventHandler
{
    /**
     * Applies one event. Throw to make Limenia retry later.
     *
     * @param array<string, mixed> $event
     */
    public function handle(array $event): void
    {
        switch ($event['type'] ?? null) {
            case 'decision.created':
                $this->applyDecision($event['decision']);
                break;
            case 'subject.status_changed':
                // Currently sent when a temporary suspension ends.
                $subject = $event['subject'];
                $this->setAccountStatus($subject['externalUserId'], $subject['status'], $subject['suspendedUntil'] ?? null);
                break;
            case 'appeal.resolved':
                $this->notifyAppellant($event['appeal']);
                break;
            case 'reports.resolved':
                $this->notifyReporters($event['reports']);
                break;
            case 'review.decided':
                // approved: publish. restricted and rejected: the decision
                // follows as decision.created with reviewId.
                if ($event['review']['outcome'] === 'approved') {
                    $this->publishSubmission($event['review']);
                }
                break;
            case 'test.ping':
                Log::info('limenia test.ping received', ['event_id' => $event['id']]);
                break;
            default:
                // Unknown types are acknowledged (2xx) so Limenia does not retry them.
                Log::info('ignoring unknown limenia event type', ['event_id' => $event['id']]);
        }
    }

    /** @param array<string, mixed> $decision */
    public function applyDecision(array $decision): void
    {
        $action = $decision['action'];
        $contentId = $decision['content']['externalContentId'] ?? null;
        $userId = $decision['subject']['externalUserId'] ?? null;

        if (! empty($decision['reviewId'])) {
            // A decision on a review request (pre-moderation) only concerns
            // the submitted content. Never change the account here.
            match ($action) {
                'reject_submission' => $this->rejectSubmission($contentId),
                'restrict_content' => $this->restrictContent($contentId), // publish with restricted visibility
                'restore' => $this->restoreContent($contentId),           // publish as submitted
                default => Log::warning('unsupported review decision', ['decision_id' => $decision['id']]),
            };

            return;
        }

        match ($action) {
            'dismiss' => null, // nothing to change; reporters learn the result via reports.resolved
            'remove_content' => $this->removeContent($contentId),
            'restrict_content' => $this->restrictContent($contentId),
            'warn_user' => $this->warnUser($userId, $decision['statementOfReasons']['text']),
            // Lift the suspension yourself at suspendUntil (UTC);
            // subject.status_changed can arrive up to about an hour later.
            'suspend_user' => $this->suspendUser($userId, $decision['suspendUntil']),
            'ban_user' => $this->banUser($userId),
            'restore' => ($decision['restoreScope'] ?? null) === 'account'
                ? $this->restoreAccount($userId)
                : $this->restoreContent($contentId),
            'reject_submission' => $this->rejectSubmission($contentId),
            // Acknowledge anyway, otherwise Limenia retries for about 20 hours.
            default => Log::warning('unsupported decision action', ['decision_id' => $decision['id']]),
        };
    }

    // --- Placeholders: replace with your own code. ---------------------------

    protected function removeContent(?string $contentId): void
    {
        Log::info('TODO remove content', ['content_id' => $contentId]);
    }

    protected function restrictContent(?string $contentId): void
    {
        Log::info('TODO restrict content', ['content_id' => $contentId]);
    }

    protected function restoreContent(?string $contentId): void
    {
        Log::info('TODO restore content', ['content_id' => $contentId]);
    }

    protected function rejectSubmission(?string $contentId): void
    {
        Log::info('TODO do not publish submission', ['content_id' => $contentId]);
    }

    /** @param array<string, mixed> $review */
    protected function publishSubmission(array $review): void
    {
        Log::info('TODO publish approved submission', ['review_id' => $review['id']]);
    }

    protected function warnUser(?string $userId, string $statementOfReasons): void
    {
        // Show the statement of reasons to the user; do not restrict the account.
        Log::info('TODO warn user', ['user_id' => $userId]);
    }

    protected function suspendUser(?string $userId, string $suspendUntil): void
    {
        Log::info('TODO suspend user', ['user_id' => $userId]);
    }

    protected function banUser(?string $userId): void
    {
        Log::info('TODO ban user', ['user_id' => $userId]);
    }

    protected function restoreAccount(?string $userId): void
    {
        Log::info('TODO re-enable account', ['user_id' => $userId]);
    }

    protected function setAccountStatus(string $userId, string $status, ?string $suspendedUntil): void
    {
        Log::info('TODO set account status', ['user_id' => $userId, 'status' => $status]);
    }

    /** @param array<string, mixed> $appeal */
    protected function notifyAppellant(array $appeal): void
    {
        // Show $appeal['statementText'] to the person who appealed.
        Log::info('TODO notify appellant', ['appeal_id' => $appeal['id']]);
    }

    /** @param array<string, mixed> $reports */
    protected function notifyReporters(array $reports): void
    {
        // Tell each reporter (items[].reportId / externalReportId) the outcome.
        Log::info('TODO notify reporters', ['decision_id' => $reports['decisionId']]);
    }
}
