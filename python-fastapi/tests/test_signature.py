import pytest

from app.signature import SignatureError, sign, verify_signature

SECRET = "whsec_test"
T = 1800000000
BODY = b'{"id":"evt_1"}'
V1 = "45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8"


def expect_error(code, header, body=BODY, secrets=(SECRET,), now=T):
    with pytest.raises(SignatureError) as err:
        verify_signature(header, body, list(secrets), now=now)
    assert err.value.code == code


def test_test_vector():
    assert sign(BODY, SECRET, T) == f"t={T},v1={V1}"
    verify_signature(f"t={T},v1={V1}", BODY, [SECRET], now=T)


def test_wrong_secret():
    expect_error("signature_mismatch", f"t={T},v1={V1}", secrets=["whsec_other"])


def test_rotation_accepts_any_configured_secret():
    verify_signature(f"t={T},v1={V1}", BODY, ["whsec_new", SECRET], now=T)


def test_old_timestamp():
    expect_error("timestamp_out_of_range", f"t={T},v1={V1}", now=T + 301)


def test_future_timestamp():
    expect_error("timestamp_out_of_range", f"t={T},v1={V1}", now=T - 301)


def test_tolerance_is_inclusive():
    verify_signature(f"t={T},v1={V1}", BODY, [SECRET], now=T + 300)
    verify_signature(f"t={T},v1={V1}", BODY, [SECRET], now=T - 300)


def test_tampered_body():
    expect_error("signature_mismatch", f"t={T},v1={V1}", body=b'{"id":"evt_2"}')


def test_two_v1_values():
    verify_signature(f"t={T},v1={'0' * 64},v1={V1}", BODY, [SECRET], now=T)
    verify_signature(f"t={T}, v1={V1}, v1={'0' * 64}", BODY, [SECRET], now=T)


@pytest.mark.parametrize(
    "header",
    [
        f"v1={V1}",  # no t
        f"t={T}",  # no v1
        f"t={T},t={T},v1={V1}",  # t twice
        f"t=abc,v1={V1}",
        f"t={T},v1",
        "garbage",
    ],
)
def test_malformed(header):
    expect_error("malformed_signature", header)


def test_missing():
    expect_error("missing_signature", None)
    expect_error("missing_signature", "")
