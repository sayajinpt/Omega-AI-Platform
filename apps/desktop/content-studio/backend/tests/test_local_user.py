"""Local profile user creation (on-device Content Studio)."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, User
from app.services.local_user import LOCAL_PROFILE_EMAIL, get_or_create_local_user_db


def _session_with_schema(db_path: Path) -> tuple[Session, object]:
    engine = create_engine(
        f"sqlite:///{db_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    return session, engine


@pytest.fixture
def db(tmp_path: Path) -> Session:
    session, engine = _session_with_schema(tmp_path / "studio.db")
    yield session
    session.close()
    engine.dispose()


def test_get_or_create_local_user_idempotent(db: Session) -> None:
    a = get_or_create_local_user_db(db)
    b = get_or_create_local_user_db(db)
    assert a.id == b.id
    assert a.email == LOCAL_PROFILE_EMAIL


def test_get_or_create_local_user_parallel_race(tmp_path: Path) -> None:
    """Startup fires many API calls at once; only one INSERT must win."""
    db_file = tmp_path / "race.db"
    _, engine = _session_with_schema(db_file)
    Session = sessionmaker(bind=engine)

    def _once() -> str:
        s = Session()
        try:
            return get_or_create_local_user_db(s).email
        finally:
            s.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        emails = list(pool.map(lambda _: _once(), range(8)))

    assert all(e == LOCAL_PROFILE_EMAIL for e in emails)
    check = Session()
    try:
        count = check.execute(
            select(func.count()).select_from(User).where(User.email == LOCAL_PROFILE_EMAIL)
        ).scalar_one()
    finally:
        check.close()
        engine.dispose()
    assert count == 1
