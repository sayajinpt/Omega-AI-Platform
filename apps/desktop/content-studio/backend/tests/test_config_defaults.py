from app.config import Settings


def test_cursor_model_defaults_to_auto(monkeypatch) -> None:
    monkeypatch.delenv("CURSOR_MODEL_ID", raising=False)
    s = Settings()
    assert s.cursor_model_id == "auto"
