"""Web Push notifications to the browsers and phones that asked for reminders.

The VAPID key pair is generated once and kept next to the database, so subscriptions survive restarts.
"""

import json
import logging
from functools import lru_cache
from typing import Any

from sqlmodel import Session, select

from app.config import get_settings
from app.models.tables import PushSubscription

log = logging.getLogger(__name__)


@lru_cache
def _vapid():
    from py_vapid import Vapid

    path = get_settings().storage_dir.parent / "vapid_private.pem"
    if not path.exists():
        v = Vapid()
        v.generate_keys()
        path.parent.mkdir(parents=True, exist_ok=True)
        v.save_key(str(path))
        path.chmod(0o600)
    return Vapid.from_file(str(path))


def public_key() -> str:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import b64urlencode

    raw = _vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64urlencode(raw)


def subscribe(db: Session, account_id: str, sub: dict[str, Any]) -> PushSubscription:
    endpoint = str(sub.get("endpoint") or "")
    keys = sub.get("keys") or {}
    if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("Invalid push subscription")
    row = db.exec(select(PushSubscription).where(PushSubscription.endpoint == endpoint)).first()
    if row:
        row.account_id, row.keys = account_id, {"p256dh": keys["p256dh"], "auth": keys["auth"]}
    else:
        row = PushSubscription(account_id=account_id, endpoint=endpoint, keys={"p256dh": keys["p256dh"], "auth": keys["auth"]})
    db.add(row)
    db.commit()
    return row


def unsubscribe(db: Session, account_id: str, endpoint: str) -> None:
    row = db.exec(select(PushSubscription).where(PushSubscription.endpoint == endpoint, PushSubscription.account_id == account_id)).first()
    if row:
        db.delete(row)
        db.commit()


def send(db: Session, account_id: str, payload: dict[str, Any]) -> int:
    """Push to every device of the account; returns how many accepted it. Expired subscriptions are removed."""
    from pywebpush import WebPushException, webpush

    subs = db.exec(select(PushSubscription).where(PushSubscription.account_id == account_id)).all()
    sent = 0
    claims_sub = "mailto:" + (get_settings().push_contact or "alerts@healthcopilot.app")
    for s in subs:
        try:
            webpush({"endpoint": s.endpoint, "keys": s.keys}, json.dumps(payload, ensure_ascii=False),
                    vapid_private_key=_vapid(), vapid_claims={"sub": claims_sub}, ttl=3600, timeout=10)
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                db.delete(s)
                db.commit()
            else:
                log.warning("Push to %s failed: %s", s.endpoint[:40], str(e)[:200])
        except Exception as e:  # noqa: BLE001
            log.warning("Push to %s failed: %s", s.endpoint[:40], str(e)[:200])
    return sent
