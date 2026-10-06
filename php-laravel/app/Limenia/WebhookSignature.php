<?php

declare(strict_types=1);

namespace App\Limenia;

/**
 * Verification of the Limenia-Signature header of webhook requests.
 *
 * Header format: t=<unix seconds>,v1=<hex>[,v1=<hex>...] where
 * v1 = hex(HMAC-SHA256(secret, t . "." . rawBody)).
 *
 * Plain PHP without Laravel, so it can be tested on its own.
 */
final class WebhookSignature
{
    public const TOLERANCE_SECONDS = 300;

    /**
     * Throws InvalidSignature unless $header is a valid signature of $rawBody.
     *
     * @param string|null $header  the Limenia-Signature header
     * @param string $rawBody      the body exactly as received ($request->getContent())
     * @param list<string> $secrets the current secret and, while rotating, the previous one
     * @param int|null $now        Unix time, for tests
     */
    public static function verify(?string $header, string $rawBody, array $secrets, ?int $now = null): void
    {
        if ($header === null || $header === '') {
            throw new InvalidSignature('missing_signature');
        }

        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $header) as $part) {
            $pair = explode('=', trim($part), 2);
            if (count($pair) !== 2) {
                throw new InvalidSignature('malformed_signature');
            }
            [$key, $value] = $pair;
            if ($key === 't') {
                if ($timestamp !== null) { // t must appear exactly once
                    throw new InvalidSignature('malformed_signature');
                }
                $timestamp = $value;
            } elseif ($key === 'v1') {
                $signatures[] = $value;
            }
            // Unknown keys are ignored, so future schemes do not break this check.
        }

        if ($timestamp === null || preg_match('/\A[0-9]{1,12}\z/', $timestamp) !== 1 || $signatures === []) {
            throw new InvalidSignature('malformed_signature');
        }

        $now ??= time();
        if (abs($now - (int) $timestamp) > self::TOLERANCE_SECONDS) {
            throw new InvalidSignature('timestamp_out_of_range');
        }

        foreach ($secrets as $secret) {
            $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
            foreach ($signatures as $signature) {
                if (hash_equals($expected, $signature)) { // constant time
                    return;
                }
            }
        }
        throw new InvalidSignature('signature_mismatch');
    }

    /** Builds a valid header, for tests. */
    public static function sign(string $rawBody, string $secret, int $timestamp): string
    {
        return 't=' . $timestamp . ',v1=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    }
}
