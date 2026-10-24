import os

os.environ.setdefault("SCHEDULER", "false")

from datetime import timedelta

import pytest

from app.config import get_settings
from app.services import codes, mailer


@pytest.fixture(autouse=True)
def local_mail(monkeypatch):
    """Never send real email from tests: keep messages in mailer.outbox and return codes in responses."""
    s = get_settings()
    monkeypatch.setattr(s, "google_script_url", "")
    monkeypatch.setattr(s, "cookie_secure", False)
    monkeypatch.setattr(s, "app_url", "https://copilot.test")
    monkeypatch.setattr(codes, "RESEND_AFTER", timedelta(0))
    mailer.outbox.clear()
    yield mailer.outbox
