package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SignatureTolerance is how far the timestamp of a webhook may be from the
// local clock, in either direction. Keep the server clock in sync (NTP).
const SignatureTolerance = 300 * time.Second

var (
	ErrMissingSignature    = errors.New("missing_signature")
	ErrMalformedSignature  = errors.New("malformed_signature")
	ErrTimestampOutOfRange = errors.New("timestamp_out_of_range")
	ErrSignatureMismatch   = errors.New("signature_mismatch")
)

// VerifySignature checks the header Limenia-Signature
// (t=<unix>,v1=<hex>[,v1=<hex>...]) against the raw request body, exactly as
// received. secrets: the current secret and, during a rotation, the previous
// one. Any matching v1 value with any secret is accepted.
func VerifySignature(header string, body []byte, now time.Time, secrets ...string) error {
	if header == "" {
		return ErrMissingSignature
	}
	var ts string
	seenT := false
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return ErrMalformedSignature
		}
		switch key {
		case "t":
			if seenT { // t must appear exactly once
				return ErrMalformedSignature
			}
			seenT, ts = true, value
		case "v1":
			if sig, err := hex.DecodeString(value); err == nil {
				sigs = append(sigs, sig)
			}
		}
	}
	unix, err := strconv.ParseInt(ts, 10, 64)
	if !seenT || err != nil || unix < 0 || len(sigs) == 0 {
		return ErrMalformedSignature
	}
	if d := now.Sub(time.Unix(unix, 0)); d > SignatureTolerance || d < -SignatureTolerance {
		return ErrTimestampOutOfRange
	}
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(ts + "."))
		mac.Write(body)
		want := mac.Sum(nil)
		for _, sig := range sigs {
			if hmac.Equal(sig, want) { // constant time
				return nil
			}
		}
	}
	return ErrSignatureMismatch
}

// Sign builds a valid Limenia-Signature header, for tests.
func Sign(body []byte, secret string, unix int64) string {
	ts := strconv.FormatInt(unix, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}
