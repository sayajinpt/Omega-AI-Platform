from app.core.security import hash_password, verify_password


def test_password_hash_roundtrip() -> None:
    h = hash_password("secret-password")
    assert verify_password("secret-password", h)
    assert not verify_password("wrong", h)


def test_password_truncates_over_72_bytes() -> None:
    long_pw = "x" * 200
    h = hash_password(long_pw)
    assert verify_password(long_pw, h)
    assert verify_password("x" * 72, h)
