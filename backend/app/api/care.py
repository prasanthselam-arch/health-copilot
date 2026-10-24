"""Engagement layer: reminders, appointments, health insights, wellness tips, the copilot's activity and Web Push."""

from datetime import date, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.api.deps import current_account, patient_or_404
from app.db import get_session
from app.models.tables import Account, Appointment, CopilotAction, Patient, Reminder
from app.services import agent, care, push, reminders, scheduler
from app.services.facts import med_fact
from app.services.reminders import now_ist
from app.services.safety import DISCLAIMER, LANGUAGES
from app.services.translate import translate_strings

router = APIRouter(tags=["care"])


def _patients(db: Session, acc: Account) -> list[Patient]:
    return list(db.exec(select(Patient).where(Patient.owner_id == acc.id).order_by(col(Patient.created_at))).all())


def _reminder_or_404(rid: str, acc: Account, db: Session) -> Reminder:
    r = db.get(Reminder, rid)
    p = db.get(Patient, r.patient_id) if r else None
    if not r or not p or p.owner_id != acc.id or r.status == "removed":
        raise HTTPException(404, "Reminder not found")
    return r


def _appointment_or_404(aid: str, acc: Account, db: Session) -> Appointment:
    a = db.get(Appointment, aid)
    p = db.get(Patient, a.patient_id) if a else None
    if not a or not p or p.owner_id != acc.id:
        raise HTTPException(404, "Appointment not found")
    return a


def _lang(lang: str) -> str:
    return lang if lang in LANGUAGES else "en"


# ---------------------------------------------------------------- today and reminders

@router.get("/api/today")
def today(day: str | None = None, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Every family member's doses for the day, and visits or tests coming up in the next two weeks."""
    now = now_ist()
    try:
        d = date.fromisoformat(day) if day else now.date()
    except ValueError as e:
        raise HTTPException(400, "Use YYYY-MM-DD") from e
    patients = _patients(db, acc)
    for p in patients:
        reminders.sync_medicine_reminders(db, p.id, now.date())
    db.commit()
    names = {p.id: p.name for p in patients}
    appts = [a for a in reminders.upcoming_appointments(db, list(names)) if a.due_date <= d + timedelta(days=14)]
    return {"day": d.isoformat(), "now": now.isoformat(), "doses": reminders.doses_for_day(db, patients, d, now),
            "appointments": [{**a.model_dump(mode="json"), "patient_name": names[a.patient_id]} for a in appts]}


@router.get("/api/reminders/due")
def due(acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Doses to announce in an open app right now (the same rule as push notifications)."""
    return scheduler.due_now(db, acc, now_ist())


@router.get("/api/patients/{patient_id}/reminders")
def list_reminders(p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    reminders.sync_medicine_reminders(db, p.id)
    db.commit()
    rows = db.exec(select(Reminder).where(Reminder.patient_id == p.id, Reminder.status != "removed")
                   .order_by(col(Reminder.created_at))).all()
    appts = db.exec(select(Appointment).where(Appointment.patient_id == p.id, Appointment.status != "cancelled")
                    .order_by(col(Appointment.due_date))).all()
    return {"reminders": [r.model_dump(mode="json") for r in rows], "appointments": [a.model_dump(mode="json") for a in appts],
            "adherence": reminders.adherence(db, p)}


class Slot(BaseModel):
    time: str
    amount: str | None = None


class ReminderIn(BaseModel):
    title: str
    detail: str | None = None
    slots: list[Slot]
    start_date: date | None = None
    end_date: date | None = None
    weekdays: list[int] | None = None


@router.post("/api/patients/{patient_id}/reminders")
def create_reminder(body: ReminderIn, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    if not body.title.strip():
        raise HTTPException(400, "Add a name for the reminder")
    try:
        slots = reminders.validate_slots([s.model_dump() for s in body.slots])
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    r = Reminder(patient_id=p.id, title=body.title.strip()[:120], detail=(body.detail or "").strip()[:200] or None, slots=slots,
                 start_date=body.start_date or now_ist().date(), end_date=body.end_date, weekdays=body.weekdays, source="user")
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


class ReminderPatch(BaseModel):
    title: str | None = None
    detail: str | None = None
    slots: list[Slot] | None = None
    end_date: date | None = None
    clear_end_date: bool = False
    status: Literal["active", "paused", "ended"] | None = None


@router.patch("/api/reminders/{rid}")
def update_reminder(rid: str, body: ReminderPatch, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    r = _reminder_or_404(rid, acc, db)
    if body.title is not None and body.title.strip():
        r.title = body.title.strip()[:120]
    if body.detail is not None:
        r.detail = body.detail.strip()[:200] or None
    if body.slots is not None:
        try:
            r.slots = reminders.validate_slots([s.model_dump() for s in body.slots])
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    if body.end_date is not None:
        r.end_date = body.end_date
    if body.clear_end_date:
        r.end_date = None
    if body.status:
        r.status = body.status
        if body.status == "ended":
            r.end_date = min(r.end_date or now_ist().date(), now_ist().date())
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@router.delete("/api/reminders/{rid}")
def delete_reminder(rid: str, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    r = _reminder_or_404(rid, acc, db)
    r.status = "removed"  # kept so the copilot does not schedule it again for the same prescription
    db.add(r)
    db.commit()
    return {"deleted": True}


class DoseIn(BaseModel):
    day: date
    time: str
    action: Literal["taken", "skipped", "snoozed", "undo"]
    minutes: int = 15


@router.post("/api/reminders/{rid}/doses")
def dose(rid: str, body: DoseIn, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    r = _reminder_or_404(rid, acc, db)
    if body.day > now_ist().date() + timedelta(days=1):
        raise HTTPException(400, "That dose is not due yet")
    try:
        lg = reminders.record_dose(db, r, body.day, body.time, body.action, max(5, min(body.minutes, 240)))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": lg.status, "snooze_until": lg.snooze_until.isoformat() if lg.snooze_until else None}


# ---------------------------------------------------------------- appointments

class AppointmentIn(BaseModel):
    kind: Literal["visit", "test"] = "visit"
    title: str
    due_date: date
    time: str | None = None
    doctor: str | None = None
    facility: str | None = None
    notes: str | None = None


def _clean_time(t: str | None) -> str | None:
    if not t:
        return None
    if not reminders.TIME_RE.match(t):
        raise HTTPException(400, "Use a 24-hour HH:MM time")
    return t


@router.post("/api/patients/{patient_id}/appointments")
def create_appointment(body: AppointmentIn, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    if not body.title.strip():
        raise HTTPException(400, "Add a title")
    a = Appointment(patient_id=p.id, kind=body.kind, title=body.title.strip()[:160], due_date=body.due_date,
                    time=_clean_time(body.time), doctor=body.doctor, facility=body.facility, notes=body.notes, source="user")
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


class AppointmentPatch(BaseModel):
    title: str | None = None
    due_date: date | None = None
    time: str | None = None
    doctor: str | None = None
    facility: str | None = None
    notes: str | None = None
    status: Literal["upcoming", "done", "cancelled"] | None = None


@router.patch("/api/appointments/{aid}")
def update_appointment(aid: str, body: AppointmentPatch, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    a = _appointment_or_404(aid, acc, db)
    data = body.model_dump(exclude_unset=True)
    if "time" in data:
        data["time"] = _clean_time(data["time"])
    for k, v in data.items():
        setattr(a, k, v)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


@router.delete("/api/appointments/{aid}")
def delete_appointment(aid: str, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    a = _appointment_or_404(aid, acc, db)
    a.status = "cancelled"
    db.add(a)
    db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------- insights, preventive steps and wellness

_TEXT_FIELDS = ("title", "body", "why", "next_step", "question")


def _localise(db: Session, patient_id: str, scope: str, groups: list[list[dict[str, Any]]], lang: str) -> bool:
    strings, slots = [], []
    for g in groups:
        for item in g:
            for f in _TEXT_FIELDS + ("detail",):
                if isinstance(item.get(f), str) and item[f]:
                    strings.append(item[f])
                    slots.append((item, f))
            for sub in item.get("items") or []:
                if isinstance(sub, dict) and isinstance(sub.get("label"), str) and scope == "copilot" and item.get("kind") == "questions":
                    strings.append(sub["label"])
                    slots.append((sub, "label"))
    out, ok = translate_strings(db, patient_id, scope, strings, lang)
    for (item, f), text in zip(slots, out):
        item[f] = text
    return ok


@router.get("/api/patients/{patient_id}/care")
def care_overview(lang: str = "en", p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    lang = _lang(lang)
    data = care.care_overview(db, p, now_ist().date())
    data["translated"] = _localise(db, p.id, "care", [data["insights"], data["preventive"], data["wellness"]], lang)
    data["language"], data["disclaimer"] = lang, DISCLAIMER[lang]
    return data


# ---------------------------------------------------------------- the copilot's activity

@router.get("/api/patients/{patient_id}/copilot")
def copilot(lang: str = "en", p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    agent.sweep(db, p)
    rows = db.exec(select(CopilotAction).where(CopilotAction.patient_id == p.id).order_by(col(CopilotAction.created_at).desc())).all()
    items = [r.model_dump(mode="json") for r in rows][:60]
    _localise(db, p.id, "copilot", [items], _lang(lang))
    return items


class Decision(BaseModel):
    decision: Literal["keep", "undo", "accept", "dismiss", "edit"]
    items: list[dict[str, Any]] | None = None


@router.post("/api/copilot/{aid}")
def decide(aid: str, body: Decision, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    a = db.get(CopilotAction, aid)
    p = db.get(Patient, a.patient_id) if a else None
    if not a or not p or p.owner_id != acc.id:
        raise HTTPException(404, "Not found")
    try:
        return agent.resolve(db, a, body.decision, body.items)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/api/patients/{patient_id}/visit-prep")
def visit_prep(lang: str = "en", p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    """A one-page sheet for the next doctor visit: questions, medicines, results that need attention, due tests."""
    lang = _lang(lang)
    today_ = now_ist().date()
    prof = care.build_profile(db, p)
    q_action = db.exec(select(CopilotAction).where(CopilotAction.patient_id == p.id, CopilotAction.kind == "questions",
                                                   col(CopilotAction.status).in_(["done", "kept"]))
                       .order_by(col(CopilotAction.created_at).desc())).first()
    questions = [i["label"] for i in q_action.items] if q_action else agent.draft_questions(db, p)
    insights = [i for i in care.insights(prof) if i["level"] != "good"]
    due = [x for x in care.preventive(prof, list(db.exec(select(Appointment).where(Appointment.patient_id == p.id)).all()), today_)
           if x["status"] in ("overdue", "due_soon", "not_done")]
    q_items = [{"title": q} for q in questions]
    _localise(db, p.id, "visit", [q_items, insights, due], lang)
    return {"patient": {"name": p.name, "age": prof.age, "gender": prof.sex, "conditions": sorted(prof.condition_names.values())},
            "questions": [q["title"] for q in q_items], "questions_action_id": q_action.id if q_action else None,
            "medications": [med_fact(m) for m in prof.meds], "insights": insights, "due": due,
            "adherence": reminders.adherence(db, p), "generated_on": today_.isoformat(), "disclaimer": DISCLAIMER[lang]}


# ---------------------------------------------------------------- Web Push

@router.get("/api/push/key")
def push_key():
    return {"public_key": push.public_key()}


class PushSub(BaseModel):
    endpoint: str
    keys: dict[str, str]


@router.post("/api/push/subscribe")
def push_subscribe(body: PushSub, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        push.subscribe(db, acc.id, body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"subscribed": True}


class PushUnsub(BaseModel):
    endpoint: str


@router.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushUnsub, acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    push.unsubscribe(db, acc.id, body.endpoint)
    return {"subscribed": False}


@router.post("/api/push/test")
def push_test(acc: Account = Depends(current_account), db: Session = Depends(get_session)):
    n = push.send(db, acc.id, {"title": "Health Copilot reminders are on", "body": "You'll get medicine and visit reminders here.",
                               "tag": "test", "url": "/reminders"})
    return {"sent": n}
