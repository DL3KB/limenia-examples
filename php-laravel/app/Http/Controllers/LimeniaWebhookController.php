<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Limenia\InvalidSignature;
use App\Limenia\LimeniaEventHandler;
use App\Limenia\WebhookSignature;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * Receives Limenia webhooks: verify the signature on the raw body,
 * deduplicate by event ID, handle, answer 204.
 */
class LimeniaWebhookController extends Controller
{
    public function __invoke(Request $request, LimeniaEventHandler $handler): Response
    {
        $rawBody = $request->getContent(); // the raw bytes, exactly as signed
        if (strlen($rawBody) > 1024 * 1024) {
            return response()->noContent(413);
        }

        try {
            WebhookSignature::verify(
                $request->header('Limenia-Signature'),
                $rawBody,
                config('limenia.webhook_secrets'),
            );
        } catch (InvalidSignature $e) {
            return response()->json(['code' => $e->getMessage()], 401);
        }

        $event = json_decode($rawBody, true);
        if (! is_array($event) || ! is_string($event['id'] ?? null)) {
            return response()->json(['code' => 'invalid_body'], 400);
        }

        // Processed event IDs. The cache is fine for a start; a table with a
        // unique key on the event ID is safer in production.
        $processedKey = 'limenia:event:' . $event['id'];
        if (Cache::has($processedKey)) {
            return response()->noContent(); // duplicate: acknowledge only
        }

        try {
            $handler->handle($event);
        } catch (\Throwable $e) {
            Log::error('limenia event failed', ['event_id' => $event['id'], 'exception' => $e::class]);

            return response()->noContent(503); // Limenia retries later
        }

        Cache::put($processedKey, true, now()->addDays(3));

        return response()->noContent();
    }
}
