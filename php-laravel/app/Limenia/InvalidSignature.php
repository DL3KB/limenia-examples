<?php

declare(strict_types=1);

namespace App\Limenia;

/**
 * The request is not a valid Limenia webhook. The message is one of
 * missing_signature, malformed_signature, timestamp_out_of_range or
 * signature_mismatch.
 */
final class InvalidSignature extends \RuntimeException
{
}
