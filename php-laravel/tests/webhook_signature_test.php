<?php

// Framework-free test of the signature verifier: php tests/webhook_signature_test.php

declare(strict_types=1);

require __DIR__ . '/../app/Limenia/InvalidSignature.php';
require __DIR__ . '/../app/Limenia/WebhookSignature.php';

use App\Limenia\InvalidSignature;
use App\Limenia\WebhookSignature;

const SECRET = 'whsec_test';
const T = 1800000000;
const BODY = '{"id":"evt_1"}';
const V1 = '45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8';

$failures = 0;

/**
 * @param string|null $expected null if the signature must be valid, else the error code
 */
function check(string $name, ?string $expected, ?string $header, string $body = BODY, array $secrets = [SECRET], int $now = T): void
{
    global $failures;
    try {
        WebhookSignature::verify($header, $body, $secrets, $now);
        $got = null;
    } catch (InvalidSignature $e) {
        $got = $e->getMessage();
    }
    if ($got === $expected) {
        echo "ok   {$name}\n";
    } else {
        echo "FAIL {$name}: expected " . ($expected ?? 'valid') . ', got ' . ($got ?? 'valid') . "\n";
        $failures++;
    }
}

$valid = 't=' . T . ',v1=' . V1;
$zeros = str_repeat('0', 64);

if (WebhookSignature::sign(BODY, SECRET, T) === $valid) {
    echo "ok   sign() matches the test vector\n";
} else {
    echo "FAIL sign() does not match the test vector\n";
    $failures++;
}

check('test vector', null, $valid);
check('wrong secret', 'signature_mismatch', $valid, BODY, ['whsec_other']);
check('rotation: second secret matches', null, $valid, BODY, ['whsec_new', SECRET]);
check('old timestamp', 'timestamp_out_of_range', $valid, BODY, [SECRET], T + 301);
check('future timestamp', 'timestamp_out_of_range', $valid, BODY, [SECRET], T - 301);
check('300 s old is fine', null, $valid, BODY, [SECRET], T + 300);
check('300 s ahead is fine', null, $valid, BODY, [SECRET], T - 300);
check('tampered body', 'signature_mismatch', $valid, '{"id":"evt_2"}');
check('two v1, second matches', null, 't=' . T . ',v1=' . $zeros . ',v1=' . V1);
check('two v1, first matches, spaces', null, 't=' . T . ', v1=' . V1 . ', v1=' . $zeros);
check('missing header', 'missing_signature', null);
check('empty header', 'missing_signature', '');
check('no t', 'malformed_signature', 'v1=' . V1);
check('no v1', 'malformed_signature', 't=' . T);
check('t twice', 'malformed_signature', 't=' . T . ',t=' . T . ',v1=' . V1);
check('t not a number', 'malformed_signature', 't=abc,v1=' . V1);
check('part without =', 'malformed_signature', 't=' . T . ',v1');

if ($failures > 0) {
    echo "{$failures} failed\n";
    exit(1);
}
echo "all passed\n";
