package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	testSecret = "whsec_test"
	testT      = 1800000000
	testV1     = "45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8"
)

var (
	testBody = []byte(`{"id":"evt_1"}`)
	testNow  = time.Unix(testT, 0)
	zeros    = strings.Repeat("0", 64)
)

func TestVerifySignature(t *testing.T) {
	valid := "t=1800000000,v1=" + testV1
	tests := []struct {
		name    string
		header  string
		body    []byte
		now     time.Time
		secrets []string
		want    error
	}{
		{"test vector", valid, testBody, testNow, []string{testSecret}, nil},
		{"wrong secret", valid, testBody, testNow, []string{"whsec_other"}, ErrSignatureMismatch},
		{"rotation: second secret matches", valid, testBody, testNow, []string{"whsec_new", testSecret}, nil},
		{"old timestamp", valid, testBody, testNow.Add(301 * time.Second), []string{testSecret}, ErrTimestampOutOfRange},
		{"future timestamp", valid, testBody, testNow.Add(-301 * time.Second), []string{testSecret}, ErrTimestampOutOfRange},
		{"300 s old is fine", valid, testBody, testNow.Add(300 * time.Second), []string{testSecret}, nil},
		{"tampered body", valid, []byte(`{"id":"evt_2"}`), testNow, []string{testSecret}, ErrSignatureMismatch},
		{"two v1, second matches", "t=1800000000,v1=" + zeros + ",v1=" + testV1, testBody, testNow, []string{testSecret}, nil},
		{"two v1, first matches, spaces", "t=1800000000, v1=" + testV1 + ", v1=" + zeros, testBody, testNow, []string{testSecret}, nil},
		{"missing header", "", testBody, testNow, []string{testSecret}, ErrMissingSignature},
		{"no t", "v1=" + testV1, testBody, testNow, []string{testSecret}, ErrMalformedSignature},
		{"no v1", "t=1800000000", testBody, testNow, []string{testSecret}, ErrMalformedSignature},
		{"t twice", "t=1800000000,t=1800000000,v1=" + testV1, testBody, testNow, []string{testSecret}, ErrMalformedSignature},
		{"t not a number", "t=abc,v1=" + testV1, testBody, testNow, []string{testSecret}, ErrMalformedSignature},
		{"part without =", "t=1800000000,v1", testBody, testNow, []string{testSecret}, ErrMalformedSignature},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := VerifySignature(tt.header, tt.body, tt.now, tt.secrets...)
			if !errors.Is(err, tt.want) {
				t.Fatalf("got %v, want %v", err, tt.want)
			}
		})
	}
}

func TestSignMatchesTestVector(t *testing.T) {
	if got := Sign(testBody, testSecret, testT); got != "t=1800000000,v1="+testV1 {
		t.Fatalf("got %s", got)
	}
}

func TestDeviceRequestHash(t *testing.T) {
	// base64url without padding of a 32-byte digest has 43 characters.
	h := DeviceRequestHash("u_112", "nonce")
	if len(h) != 43 || strings.ContainsAny(h, "+/=") {
		t.Fatalf("unexpected hash %q", h)
	}
}
