"""Verification of the `Limenia-Signature` header of webhook requests.

Header format: `t=<unix seconds>,v1=<hex>[,v1=<hex>...]` where
`v1 = hex(HMAC-SHA256(secret, t + "." + raw_body))`.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from collections.abc import Sequence

TOLERANCE_SECONDS = 300
_TIMESTAMP = re.compile(r"[0-9]{1,12}")


class SignatureError(Exception):
    """The request is not a valid Limenia webhook. `code` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def verify_signature(
    header: str | None,
    raw_body: bytes,
    secrets: Sequence[str],
    now: float | None = None,
) -> None:
    """Raise SignatureError unless `header` is a valid signature of `raw_body`.

    `raw_body` must be the body exactly as received, never re-serialized JSON.
    `secrets` is the current secret and, during a rotation, the previous one.
    """
    if not header:
        raise SignatureError("missing_signature")

    timestamp: str | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, sep, value = part.strip().partition("=")
        if not sep:
            raise SignatureError("malformed_signature")
        if key == "t":
            if timestamp is not None:  # `t` must appear exactly once
                raise SignatureError("malformed_signature")
            timestamp = value
        elif key == "v1":
            signatures.append(value)
        # Unknown keys are ignored, so future schemes do not break this check.

    if timestamp is None or not _TIMESTAMP.fullmatch(timestamp) or not signatures:
        raise SignatureError("malformed_signature")

    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > TOLERANCE_SECONDS:
        raise SignatureError("timestamp_out_of_range")

    signed_payload = timestamp.encode() + b"." + raw_body
    for secret in secrets:
        expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest().encode()
        for signature in signatures:
            if hmac.compare_digest(expected, signature.encode()):
                return
    raise SignatureError("signature_mismatch")


def sign(raw_body: bytes, secret: str, timestamp: int) -> str:
    """Build a valid header, for tests and local experiments."""
    mac = hmac.new(secret.encode(), str(timestamp).encode() + b"." + raw_body, hashlib.sha256)
    return f"t={timestamp},v1={mac.hexdigest()}"
