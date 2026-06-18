import pytest

from app.services.duration_policy import MAX_TECHNICAL_SECONDS, normalize_duration_seconds


def test_normalize_default():
    assert normalize_duration_seconds(None) == 600


def test_normalize_user_seconds():
    assert normalize_duration_seconds(10) == 10
    assert normalize_duration_seconds(86_400) == 86_400


def test_normalize_rejects_invalid():
    with pytest.raises(ValueError, match="at least 1"):
        normalize_duration_seconds(0)
    with pytest.raises(ValueError, match="technical limit"):
        normalize_duration_seconds(MAX_TECHNICAL_SECONDS + 1)
