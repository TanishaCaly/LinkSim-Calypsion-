"""
The tests run on their own PostgreSQL database (linksim_test), never on the
real one. Its address comes from TEST_DATABASE_URL — the environment, or the
TEST_DATABASE_URL= line in .env.postgres (project root, not in git).
"""
import os
from pathlib import Path

import pytest


def _test_database_url() -> str:
    url = os.getenv("TEST_DATABASE_URL", "").strip()
    env_file = Path(__file__).resolve().parents[2] / ".env.postgres"
    if not url and env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("TEST_DATABASE_URL="):
                url = line.split("=", 1)[1].strip()
    return url


_url = _test_database_url()
if not _url:
    pytest.exit("TEST_DATABASE_URL is not set: add the linksim_test PostgreSQL address to .env.postgres "
                "(TEST_DATABASE_URL=postgresql+psycopg://...@127.0.0.1:5432/linksim_test).", returncode=4)
if not _url.rsplit("/", 1)[-1].split("?", 1)[0].endswith("_test"):
    pytest.exit("TEST_DATABASE_URL must point to a database whose name ends in _test — "
                "the tests empty it.", returncode=4)
# Before anything imports backend.storage, so the app's engine is the test database.
os.environ["DATABASE_URL"] = _url
