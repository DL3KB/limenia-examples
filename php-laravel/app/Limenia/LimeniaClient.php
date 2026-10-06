<?php

declare(strict_types=1);

namespace App\Limenia;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * A tiny client for the Limenia ingest API (/v1) on top of Laravel's HTTP client.
 */
final class LimeniaClient
{
    private const MAX_ATTEMPTS = 5;      // waits 1, 2, 4 and 8 seconds between attempts
    private const MAX_WAIT_SECONDS = 30; // a longer Retry-After is passed on instead

    /**
     * Sends a request. With $retry, network errors, 429 and 5xx are retried
     * with exponential backoff, waiting at least Retry-After; the same body and
     * headers (including Idempotency-Key) go out every time. The last response
     * is returned as it is; a network error on the last attempt is thrown.
     *
     * @param string|null $jsonBody already encoded JSON
     * @param array<string, string> $headers
     *
     * @throws ConnectionException
     */
    public function send(string $method, string $path, ?string $jsonBody = null, array $headers = [], bool $retry = true): Response
    {
        $backoff = 1;
        for ($attempt = 1; ; $attempt++) {
            $last = ! $retry || $attempt >= self::MAX_ATTEMPTS;
            $request = Http::baseUrl(rtrim((string) config('limenia.base_url'), '/'))
                ->withToken((string) config('limenia.api_key'))
                ->withHeaders($headers)
                ->acceptJson()
                ->timeout(30); // Limenia scales to zero; the first request after a pause can be slow
            if ($jsonBody !== null) {
                $request = $request->withBody($jsonBody, 'application/json');
            }

            try {
                $response = $request->send($method, $path);
            } catch (ConnectionException $e) {
                if ($last) {
                    throw $e;
                }
                sleep($backoff);
                $backoff *= 2;
                continue;
            }

            $status = $response->status();
            if ($last || ($status !== 429 && $status < 500)) {
                return $response;
            }
            $wait = max($backoff, (int) $response->header('Retry-After'));
            if ($wait > self::MAX_WAIT_SECONDS) {
                return $response;
            }
            sleep($wait);
            $backoff *= 2;
        }
    }

    /** base64url(SHA-256("limenia:" . externalUserId . ":" . nonce)) without padding. */
    public static function deviceRequestHash(string $externalUserId, string $nonce): string
    {
        $digest = hash('sha256', 'limenia:' . $externalUserId . ':' . $nonce, true);

        return rtrim(strtr(base64_encode($digest), '+/', '-_'), '=');
    }
}
