<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Limenia\LimeniaClient;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response as LimeniaResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Endpoints for your app: reports, the user's own status and device checks.
 */
class LimeniaController extends Controller
{
    /** Fields the app may set in a report. source and reporter are set here. */
    private const REPORT_FIELDS = ['reasonCategory', 'reasonText', 'goodFaith', 'subject', 'content', 'externalReportId'];

    public function __construct(private readonly LimeniaClient $limenia)
    {
    }

    /** POST /reports: a signed-in user reports content or another user. */
    public function createReport(Request $request): Response
    {
        $userId = $this->currentUser($request);

        // Decode to objects, so empty JSON objects stay objects when re-encoded.
        $input = json_decode($request->getContent());
        if (! $input instanceof \stdClass) {
            return $this->problem(400, 'bad_request', 'Body must be a JSON object');
        }
        $report = new \stdClass();
        foreach (self::REPORT_FIELDS as $field) {
            if (property_exists($input, $field)) {
                $report->{$field} = $input->{$field};
            }
        }
        $report->source = 'user';
        $report->reporter = ['externalUserId' => $userId]; // from the login, never from the body

        // The app should create one key per report and resend it on every
        // retry. Without one, generate it here; it then only covers our retries.
        $key = $request->header('Idempotency-Key') ?: 'report-' . Str::uuid();

        try {
            $response = $this->limenia->send('POST', '/v1/reports', $this->json($report), ['Idempotency-Key' => $key]);
        } catch (ConnectionException) {
            return $this->problem(502, 'limenia_unreachable', 'Limenia could not be reached');
        }

        $forwarded = $this->forward($response);
        $forwarded->headers->set('Idempotency-Key', $key);

        return $forwarded;
    }

    /** GET /me/moderation-status: only ever for the signed-in user. */
    public function myStatus(Request $request): Response
    {
        $userId = $this->currentUser($request);
        try {
            $response = $this->limenia->send('GET', '/v1/subjects/' . rawurlencode($userId) . '/status');
        } catch (ConnectionException) {
            return $this->problem(502, 'limenia_unreachable', 'Limenia could not be reached');
        }

        return $this->forward($response);
    }

    /**
     * POST /devices/request-hash: step 1 of a device check. The app passes the
     * hash to LimeniaDevice.requestToken (Flutter plugin limenia_device).
     */
    public function deviceRequestHash(Request $request): Response
    {
        $userId = $this->currentUser($request);
        $hash = LimeniaClient::deviceRequestHash($userId, Str::random(32));
        // Limenia rejects device tokens older than 15 minutes.
        Cache::put($this->hashKey($userId), $hash, now()->addMinutes(10));

        return response()->json(['requestHash' => $hash]);
    }

    /**
     * POST /devices/check: step 2. The app sends {platform, token[, event,
     * environment]}. Call it at registration and at every login, also for a
     * banned account before you reject the login.
     */
    public function deviceCheck(Request $request): Response
    {
        $userId = $this->currentUser($request);
        $check = [
            'externalUserId' => $userId, // from the login, never from the body
            'platform' => (string) $request->input('platform'), // android, ios or test
            'token' => (string) $request->input('token'),
        ];
        if ($request->filled('event')) {
            $check['event'] = (string) $request->input('event'); // registration, login, report or other
        }
        if ($request->filled('environment')) {
            $check['environment'] = (string) $request->input('environment'); // iOS debug builds: development
        }
        $hash = Cache::pull($this->hashKey($userId)); // single use
        if ($check['platform'] === 'android') {
            if ($hash === null) {
                return $this->problem(400, 'request_hash_missing', 'Request a hash first');
            }
            $check['requestHash'] = $hash;
        }

        // No retries: a device token is single-use.
        try {
            $response = $this->limenia->send('POST', '/v1/devices/check', $this->json($check), [], retry: false);
        } catch (ConnectionException) {
            $response = null;
        }
        if ($response === null || $response->status() === 429 || $response->serverError()) {
            // Fail open. Never reject a login because the check could not run.
            return response()->json(['status' => 'unevaluated', 'deviceFlag' => 'unknown']);
        }

        // 200: see the README for how to use status, deviceFlag and subject.status.
        return $this->forward($response);
    }

    /**
     * REPLACE WITH YOUR LOGIN. This stub trusts an X-User-Id header so the
     * example runs without an auth system. With Sanctum, for example:
     * return (string) $request->user()->getAuthIdentifier();
     * Return the stable internal ID you also use as externalUserId.
     */
    private function currentUser(Request $request): string
    {
        $userId = (string) $request->header('X-User-Id');
        abort_if($userId === '', 401, 'Not signed in');

        return $userId;
    }

    /** Passes Limenia's status, body (JSON or problem+json) and Retry-After on. */
    private function forward(LimeniaResponse $response): Response
    {
        $headers = ['Content-Type' => $response->header('Content-Type') ?: 'application/json'];
        if ($response->header('Retry-After') !== '') {
            $headers['Retry-After'] = $response->header('Retry-After');
        }

        return response($response->body(), $response->status(), $headers);
    }

    private function problem(int $status, string $code, string $title): Response
    {
        return response()->json(
            ['type' => 'about:blank', 'title' => $title, 'status' => $status, 'code' => $code],
            $status,
            ['Content-Type' => 'application/problem+json'],
        );
    }

    private function json(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private function hashKey(string $userId): string
    {
        return 'limenia:device-hash:' . hash('sha256', $userId);
    }
}
