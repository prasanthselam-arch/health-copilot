"""Medicine reminders and appointments, built from the user's own prescriptions and notes.

Times are India Standard Time. A prescription's morning / afternoon / night doses and meal timing become dose
times; the course length becomes the last day; a newer prescription of the same drug ends the old reminder.
"""

import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.models.tables import Appointment, Document, DoseLog, MedicationRequest, Patient, Reminder
from app.services.records import medication_status

IST = timezone(timedelta(hours=5, minutes=30))
SLOTS = ("morning", "afternoon", "night")
SLOT_TIME = {"morning": "08:00", "afternoon": "14:00", "night": "21:00"}
BEFORE_FOOD = {"morning": "07:30", "afternoon": "13:30", "night": "20:30"}
FREQ_SLOTS = {"OD": ("morning",), "BD": ("morning", "night"), "TDS": ("morning", "afternoon", "night"),
              "QID": ("morning", "afternoon", "night"), "HS": ("night",), "WEEKLY": ("morning",)}
NO_REMINDER = {"SOS", "STAT"}
MISSED_AFTER = timedelta(hours=2)
SNOOZE_CHOICES = (10, 15, 30, 60)
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def now_ist() -> datetime:
    return datetime.now(IST)


def _amount(v: float | None, m: MedicationRequest) -> str:
    if not v:
        return m.dose or ""
    n = {0.5: "½", 0.25: "¼", 1.5: "1½"}.get(v, f"{v:g}")
    unit = m.form if m.form in ("tablet", "capsule") else None
    if unit:
        return f"{n} {unit}" + ("s" if v > 1 else "")
    return m.dose or n


def slots_for(m: MedicationRequest) -> list[dict[str, Any]]:
    """Daily dose times for a prescription line; empty when it should not be reminded (as needed, one-off)."""
    if (m.frequency_code or "") in NO_REMINDER:
        return []
    amounts = {"morning": m.morning, "afternoon": m.afternoon, "night": m.night}
    chosen = [s for s in SLOTS if amounts[s]]
    if not chosen:
        chosen = list(FREQ_SLOTS.get(m.frequency_code or "", ()))
    if m.frequency_code == "QID" and len(chosen) == 3:
        chosen.append("evening")
    out = []
    for s in chosen:
        if s == "evening":
            out.append({"time": "17:30", "slot": "afternoon", "amount": _amount(None, m)})
            continue
        t = BEFORE_FOOD[s] if m.meal_relation == "before_food" else SLOT_TIME[s]
        if m.meal_relation == "empty_stomach" and s == "morning":
            t = "07:00"
        if (m.meal_relation == "bedtime" or m.frequency_code == "HS") and s == "night":
            t = "22:00"
        out.append({"time": t, "slot": s, "amount": _amount(amounts[s], m)})
    return sorted(out, key=lambda x: x["time"])


def _meal_text(m: MedicationRequest) -> str | None:
    return {"before_food": "before food", "after_food": "after food", "with_food": "with food",
            "empty_stomach": "on an empty stomach", "bedtime": "at bedtime"}.get(m.meal_relation or "")


def _title(m: MedicationRequest) -> str:
    return " ".join(x for x in (m.name, m.strength) if x)


def course_end(m: MedicationRequest) -> date | None:
    if m.duration_days and m.authored_on:
        return m.authored_on + timedelta(days=m.duration_days - 1)
    return None


def sync_medicine_reminders(db: Session, patient_id: str, today: date | None = None) -> tuple[list[Reminder], list[Reminder]]:
    """Create reminders for active medicines that have none, and end reminders whose medicine is no longer active.

    A medicine whose reminder the user removed is never re-created. Returns (created, ended).
    """
    today = today or now_ist().date()
    meds = db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient_id)).all()
    by_med = {r.medication_id: r for r in db.exec(select(Reminder).where(Reminder.patient_id == patient_id)).all() if r.medication_id}
    created, ended = [], []
    for m in meds:
        r = by_med.get(m.id)
        active = medication_status(m, today) == "active"
        if r is None and active:
            slots = slots_for(m)
            if not slots:
                continue
            start = m.authored_on or today
            r = Reminder(patient_id=patient_id, medication_id=m.id, title=_title(m), detail=_meal_text(m), slots=slots,
                         weekdays=[start.weekday()] if m.frequency_code == "WEEKLY" else None,
                         start_date=start, end_date=course_end(m), source="copilot")
            db.add(r)
            created.append(r)
        elif r is not None and not active and r.status in ("active", "paused"):
            r.status = "ended"
            r.end_date = min(r.end_date or today, today)
            db.add(r)
            ended.append(r)
    db.flush()
    return created, ended


def _runs_on(r: Reminder, day: date) -> bool:
    if r.status not in ("active", "ended") or day < r.start_date or (r.end_date and day > r.end_date):
        return False
    if r.status == "ended" and r.end_date is None:
        return False
    return r.weekdays is None or day.weekday() in r.weekdays


def _at(day: date, hhmm: str) -> datetime:
    h, m = map(int, hhmm.split(":"))
    return datetime.combine(day, time(h, m), IST)


def doses_for_day(db: Session, patients: list[Patient], day: date, now: datetime | None = None) -> list[dict[str, Any]]:
    """Every scheduled dose on `day` for these profiles, with what happened to it."""
    now = now or now_ist()
    names = {p.id: p for p in patients}
    reminders = db.exec(select(Reminder).where(col(Reminder.patient_id).in_(list(names)))).all() if names else []
    logs = db.exec(select(DoseLog).where(col(DoseLog.patient_id).in_(list(names)), DoseLog.day == day)).all() if names else []
    log_by = {(lg.reminder_id, lg.time): lg for lg in logs}
    out = []
    for r in reminders:
        if not _runs_on(r, day):
            continue
        for s in r.slots:
            lg = log_by.get((r.id, s["time"]))
            due = _at(day, s["time"])
            status = lg.status if lg else "pending"
            if status == "snoozed" and lg and lg.snooze_until and lg.snooze_until.replace(tzinfo=lg.snooze_until.tzinfo or timezone.utc) <= now:
                status = "due"
            elif status == "pending" and now >= due + MISSED_AFTER:
                status = "missed"
            elif status == "pending" and now >= due:
                status = "due"
            p = names[r.patient_id]
            out.append({
                "reminder_id": r.id, "patient_id": r.patient_id, "patient_name": p.name, "language": p.preferred_language,
                "medication_id": r.medication_id, "title": r.title, "detail": r.detail, "amount": s.get("amount") or "",
                "slot": s.get("slot") or slot_of(s["time"]), "time": s["time"], "day": day.isoformat(), "status": status,
                "snooze_until": lg.snooze_until.isoformat() if lg and lg.snooze_until and status == "snoozed" else None,
                "was_snoozed": bool(lg and lg.status == "snoozed"),
                "acted_at": lg.acted_at.isoformat() if lg else None,
            })
    return sorted(out, key=lambda d: (d["time"], d["patient_name"], d["title"]))


def slot_of(hhmm: str) -> str:
    h = int(hhmm[:2])
    return "morning" if h < 12 else "afternoon" if h < 17 else "night"


def record_dose(db: Session, r: Reminder, day: date, hhmm: str, action: str, minutes: int = 15) -> DoseLog:
    if hhmm not in {s["time"] for s in r.slots}:
        raise ValueError("This reminder has no dose at that time")
    if action not in ("taken", "skipped", "snoozed", "undo"):
        raise ValueError("Unknown action")
    lg = db.exec(select(DoseLog).where(DoseLog.reminder_id == r.id, DoseLog.day == day, DoseLog.time == hhmm)).first()
    if action == "undo":
        if lg:
            db.delete(lg)
            db.commit()
        return DoseLog(reminder_id=r.id, patient_id=r.patient_id, day=day, time=hhmm, status="pending")
    lg = lg or DoseLog(reminder_id=r.id, patient_id=r.patient_id, day=day, time=hhmm, status=action)
    lg.status, lg.acted_at = action, datetime.now(timezone.utc)
    lg.snooze_until = datetime.now(timezone.utc) + timedelta(minutes=minutes) if action == "snoozed" else None
    db.add(lg)
    db.commit()
    db.refresh(lg)
    return lg


def adherence(db: Session, patient: Patient, days: int = 7, today: date | None = None) -> dict[str, Any]:
    """Doses marked taken over the last `days` days (today excluded) against doses that were scheduled."""
    today = today or now_ist().date()
    scheduled = taken = 0
    end = today - timedelta(days=1)
    for i in range(days):
        day = end - timedelta(days=i)
        for d in doses_for_day(db, [patient], day, now=_at(today, "00:00") + timedelta(days=1)):
            scheduled += 1
            taken += d["status"] == "taken"
    return {"days": days, "scheduled": scheduled, "taken": taken,
            "percent": round(taken / scheduled * 100) if scheduled else None}


def validate_slots(slots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out, seen = [], set()
    for s in slots:
        t = str(s.get("time", "")).strip()
        if not TIME_RE.match(t):
            raise ValueError(f"Use 24-hour HH:MM times, e.g. 08:00 (got {t or 'nothing'})")
        if t in seen:
            continue
        seen.add(t)
        out.append({"time": t, "slot": slot_of(t), "amount": str(s.get("amount") or "")[:40]})
    if not out:
        raise ValueError("Add at least one time")
    return sorted(out, key=lambda x: x["time"])


# ---------------------------------------------------------------- follow-ups and repeat tests in the records

_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "ten": 10, "twelve": 12,
        "a": 1, "an": 1, "1": 1}
_AFTER = re.compile(r"\b(?:after|in|within|next)\s+(\d+|one|two|three|four|five|six|seven|eight|ten|twelve|an?)\s*"
                    r"(day|week|wk|month|mon|year|yr)s?\b", re.I)
_SLASH = re.compile(r"\b(\d+)\s*/\s*(7|52|12)\b")
_DATE = re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b")
_TEST_WORDS = re.compile(r"\b(repeat|recheck|re-check|check|test|redo|review)\b\s+(.+?)(?:\s+(?:after|in|within|on|next)\b|$)", re.I)


def _due_from(text: str, base: date) -> date | None:
    m = _DATE.search(text)
    if m:
        d, mo, y = (int(x) for x in m.groups())
        y = y + 2000 if y < 100 else y
        try:
            return date(y, mo, d)
        except ValueError:
            pass
    m = _AFTER.search(text)
    if m:
        g = m.group(1).lower()
        n = int(g) if g.isdigit() else _NUM.get(g, 1)
        unit = m.group(2).lower()
        days = n * (1 if unit.startswith("d") else 7 if unit.startswith("w") else 365 if unit.startswith("y") else 30)
        return base + timedelta(days=days)
    m = _SLASH.search(text)
    if m:
        n, per = int(m.group(1)), m.group(2)
        return base + timedelta(days=n * {"7": 1, "52": 7, "12": 30}[per])
    return None


def follow_ups_in(doc: Document) -> list[dict[str, Any]]:
    """Visits and repeat tests a document asks for, with the date they fall due."""
    review = doc.review or {}
    d = review.get("document", {})
    base = doc.document_date or (doc.confirmed_at.date() if doc.confirmed_at else now_ist().date())
    out, seen = [], set()
    texts = [("follow_up", d.get("follow_up"))] + [("advice", a) for a in d.get("advice") or []]
    for field, text in texts:
        if not text:
            continue
        due = _due_from(text, base)
        if not due:
            continue
        is_test = bool(re.search(r"\b(repeat|recheck|test|hba1c|lipid|cbc|tsh|sugar|profile|x-?ray|scan|usg|ecg|urine)\b", text, re.I))
        is_visit = field == "follow_up" or bool(re.search(r"\b(review|follow[- ]?up|visit|come|opd|consult)\b", text, re.I))
        kind = "visit" if is_visit else "test" if is_test else None
        if not kind:
            continue
        title = _visit_title(text, doc) if kind == "visit" else _test_title(text)
        if (kind, due) in seen:
            continue
        seen.add((kind, due))
        out.append({"kind": kind, "title": title, "due_date": due, "source_text": text.strip(),
                    "doctor": doc.author, "facility": doc.facility})
    return out


def _visit_title(text: str, doc: Document) -> str:
    who = f" with {doc.author}" if doc.author else ""
    tests = re.search(r"\bwith\s+(.+)$", text, re.I)
    bring = re.sub(r"\s*reports?$", "", tests.group(1).strip(" ."), flags=re.I) if tests else ""
    return f"Follow-up visit{who}" + (f" (bring {bring} report)" if bring else "")


def _test_title(text: str) -> str:
    m = _TEST_WORDS.search(text)
    name = m.group(2).strip(" .") if m else text.strip(" .")
    return f"Repeat {name}" if not name.lower().startswith(("repeat", "recheck")) else name[:1].upper() + name[1:]


def upcoming_appointments(db: Session, patient_ids: list[str]) -> list[Appointment]:
    if not patient_ids:
        return []
    return list(db.exec(select(Appointment).where(col(Appointment.patient_id).in_(patient_ids), Appointment.status == "upcoming")
                        .order_by(col(Appointment.due_date))).all())
