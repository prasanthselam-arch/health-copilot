"""The copilot's own actions: what it does when a record is confirmed and what it checks every day.

Applied actions (reminders scheduled, follow-ups added) can be undone; proposals (repeat tests, overdue visits) wait
for the user to accept or dismiss them. Everything is logged in CopilotAction so the user sees exactly what it did.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.models.tables import Appointment, Condition, CopilotAction, Document, MedicationRequest, Patient, Reminder
from app.services import care, reminders
from app.services.reminders import now_ist


def _times(r: Reminder) -> str:
    return ", ".join(s["time"] for s in r.slots)


def _exists(db: Session, patient_id: str, key: str) -> bool:
    return db.exec(select(CopilotAction).where(CopilotAction.patient_id == patient_id, CopilotAction.key == key)).first() is not None


def _log(db: Session, patient_id: str, key: str, kind: str, title: str, *, detail: str | None = None,
         items: list[dict[str, Any]] | None = None, ref_ids: list[str] | None = None, document_id: str | None = None,
         status: str = "done") -> CopilotAction | None:
    if _exists(db, patient_id, key):
        return None
    a = CopilotAction(patient_id=patient_id, key=key, kind=kind, title=title, detail=detail, items=items or [],
                      ref_ids=ref_ids or [], document_id=document_id, status=status)
    db.add(a)
    return a


def _remove_orphans(db: Session, patient_id: str) -> None:
    """Reminders whose medicine row was replaced (document re-confirmed or deleted) are retired quietly."""
    med_ids = {m.id for m in db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient_id)).all()}
    for r in db.exec(select(Reminder).where(Reminder.patient_id == patient_id, col(Reminder.medication_id).is_not(None))).all():
        if r.medication_id not in med_ids and r.status != "removed":
            r.status = "removed"
            db.add(r)


def after_confirm(db: Session, doc: Document) -> list[CopilotAction]:
    """Run when a document is confirmed: schedule its reminders, add its follow-ups and refresh the visit questions."""
    patient = db.get(Patient, doc.patient_id)
    if not patient:
        return []
    _remove_orphans(db, patient.id)
    actions: list[CopilotAction | None] = []
    created, ended = reminders.sync_medicine_reminders(db, patient.id)
    source = doc.title or {"prescription": "your prescription", "discharge_summary": "your discharge summary"}.get(doc.doc_type or "", "your record")
    if created:
        actions.append(_log(
            db, patient.id, f"reminders:{doc.id}", "reminders",
            f"Scheduled {len(created)} medicine reminder{'s' if len(created) != 1 else ''}",
            detail=f"From {source}. Times follow the prescription's morning / afternoon / night doses and meal timing; edit them any time.",
            items=[{"label": r.title, "detail": " · ".join(x for x in (_times(r), r.detail,
                                                                        f"until {r.end_date:%d %b}" if r.end_date else None) if x),
                    "ref": r.id} for r in created],
            ref_ids=[r.id for r in created], document_id=doc.id))
    if ended:
        actions.append(_log(
            db, patient.id, f"stopped:{doc.id}", "reminders_stopped",
            f"Stopped {len(ended)} reminder{'s' if len(ended) != 1 else ''} for medicines that are no longer active",
            detail="A newer prescription replaced them, or their course has ended.",
            items=[{"label": r.title, "ref": r.id} for r in ended], ref_ids=[r.id for r in ended], document_id=doc.id))
    for f in reminders.follow_ups_in(doc):
        dup = db.exec(select(Appointment).where(Appointment.patient_id == patient.id, Appointment.title == f["title"],
                                                Appointment.due_date == f["due_date"])).first()
        if dup:
            continue
        a = Appointment(patient_id=patient.id, kind=f["kind"], title=f["title"], due_date=f["due_date"], doctor=f["doctor"],
                        facility=f["facility"], source="copilot", source_text=f["source_text"], document_id=doc.id)
        db.add(a)
        db.flush()
        overdue = f["due_date"] < now_ist().date()
        actions.append(_log(
            db, patient.id, f"appt:{doc.id}:{f['kind']}:{f['due_date']}", "appointment",
            f"Added {'a follow-up visit' if f['kind'] == 'visit' else 'a repeat test'} for {f['due_date']:%d %b %Y}"
            + (" (already past due)" if overdue else ""),
            detail=f"The record says \u201c{f['source_text']}\u201d.",
            items=[{"label": f["title"], "detail": f"{f['due_date']:%d %b %Y}", "ref": a.id}], ref_ids=[a.id], document_id=doc.id))
    db.flush()
    q = draft_questions(db, patient, doc=doc)
    if q:
        for old in db.exec(select(CopilotAction).where(CopilotAction.patient_id == patient.id, CopilotAction.kind == "questions",
                                                       col(CopilotAction.status).in_(["done", "kept"]))).all():
            old.status = "superseded"
            db.add(old)
        actions.append(_log(
            db, patient.id, f"questions:{doc.id}", "questions", f"Drafted {len(q)} questions for your next doctor visit",
            detail=f"Based on {source} and your latest results. Edit them, then print them with your visit sheet.",
            items=[{"label": x} for x in q], document_id=doc.id))
    actions.extend(sweep(db, patient, commit=False))
    db.commit()
    return [a for a in actions if a]


def sweep(db: Session, patient: Patient, today: date | None = None, commit: bool = True) -> list[CopilotAction]:
    """Daily check: repeat tests that are due and follow-ups that were missed become proposals."""
    today = today or now_ist().date()
    reminders.sync_medicine_reminders(db, patient.id, today)
    prof = care.build_profile(db, patient)
    appts = list(db.exec(select(Appointment).where(Appointment.patient_id == patient.id)).all())
    due_items = [i for i in care.preventive(prof, appts, today)
                 if i["key"].startswith("test:") and i["status"] in ("overdue", "due_soon")]
    live = {f"{i['key']}:{i['due_date']}" for i in due_items}
    upcoming = {a.id for a in appts if a.status == "upcoming"}
    now = datetime.now(timezone.utc)
    for a in db.exec(select(CopilotAction).where(CopilotAction.patient_id == patient.id, CopilotAction.status == "proposed")).all():
        # a newer report covered the test, or the visit was marked done elsewhere: the proposal resolves itself
        if (a.kind == "test_due" and a.key not in live) or (a.kind == "overdue" and not set(a.ref_ids) & upcoming):
            a.status, a.resolved_at = "resolved", now
            db.add(a)
    out: list[CopilotAction | None] = []
    for item in due_items:
        due = date.fromisoformat(item["due_date"])
        when = (f"was due on {due:%d %b %Y}" if item["status"] == "overdue" else f"is due on {due:%d %b %Y}")
        out.append(_log(
            db, patient.id, f"{item['key']}:{item['due_date']}", "test_due",
            f"Repeat {item['title'].split(' (')[0]} {when}",
            detail=item["why"] + (f" Your last one was on {date.fromisoformat(item['last_date']):%d %b %Y}." if item["last_date"] else ""),
            items=[{"label": item["title"], "detail": item["due_date"], "test": item["key"]}], status="proposed"))
    for a in appts:
        if a.status == "upcoming" and a.due_date < today:
            out.append(_log(
                db, patient.id, f"overdue:{a.id}", "overdue", f"{a.title} was due on {a.due_date:%d %b %Y}",
                detail="Did it happen? Mark it done, or reschedule it from Reminders. If not, consider booking it.",
                items=[{"label": a.title, "detail": a.due_date.isoformat(), "ref": a.id}], ref_ids=[a.id], status="proposed"))
    if commit:
        db.commit()
    return [a for a in out if a]


# Long-term conditions a doctor sets a target or a re-test for; acute illnesses get no such question.
CONDITION_QUESTIONS = (
    (("diabet",), "What HbA1c and fasting sugar should I aim for, and how often should I check my sugar at home?"),
    (("hypertens", "blood pressure"), "What blood pressure should I aim for at home, and how often should I check it?"),
    (("thyroid",), "When should I repeat my thyroid test to check the dose is right?"),
    (("cholesterol", "lipid"), "What LDL cholesterol should I aim for?"),
    (("anaemia", "anemia"), "When should I repeat my haemoglobin test to see if the treatment is working?"),
)


def _from_document(db: Session, doc: Document) -> list[str]:
    """Questions about what this record says: its long-term conditions and the medicines it prescribes."""
    qs: list[str] = []
    by = f"Dr. {doc.author.removeprefix('Dr.').removeprefix('Dr').strip()}" if doc.author else "The doctor"
    for c in db.exec(select(Condition).where(Condition.document_id == doc.id, Condition.clinical_status == "active")).all():
        q = next((q for words, q in CONDITION_QUESTIONS if any(w in c.name.lower() for w in words)), None)
        if q:
            qs.append(f"{by} noted {c.name}. {q}")
            break
    meds = [m for m in db.exec(select(MedicationRequest).where(MedicationRequest.document_id == doc.id)).all()
            if m.frequency_code not in reminders.NO_REMINDER]
    if meds:
        names = [" ".join(x for x in (m.name, m.strength) if x) for m in meds[:3]]
        names_text = ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else names[0]
        long_course = any(not m.duration_days or m.duration_days >= 28 for m in meds)
        qs.append(f"For {names_text}: which side effects should I watch for, and "
                  + ("how long will I need to take them?" if long_course else "what should I do if I miss a dose?"))
    return qs


def draft_questions(db: Session, patient: Patient, limit: int = 3, doc: Document | None = None) -> list[str]:
    """Up to three grounded questions for the next visit, most important first."""
    prof = care.build_profile(db, patient)
    qs: list[str] = [i["question"] for i in care.insights(prof) if i.get("question") and i["level"] != "good"]
    if doc and doc.doc_type in ("prescription", "discharge_summary"):
        asks_target = any("target" in q for q in qs[:1])
        qs[1:1] = [q for q in _from_document(db, doc) if not (asks_target and "aim for" in q)]
    today = now_ist().date()
    appts = list(db.exec(select(Appointment).where(Appointment.patient_id == patient.id)).all())
    for item in care.preventive(prof, appts, today):
        if item["kind"] == "repeat_test" and item["status"] == "overdue":
            qs.append(f"My {item['title'].split(' (')[0]} test was due on {date.fromisoformat(item['due_date']):%d %b %Y}. Should I get it done before our next visit?")
    if len(prof.meds) >= 4:
        qs.append(f"I take {len(prof.meds)} medicines now. Can we review together whether I still need all of them?")
    elif prof.meds and len(qs) < limit:
        qs.append("Are there side effects of my current medicines I should watch for?")
    seen, out = set(), []
    for q in qs:
        k = q[:40]
        if k not in seen:
            seen.add(k)
            out.append(q)
    return out[:limit]


def resolve(db: Session, a: CopilotAction, decision: str, items: list[dict[str, Any]] | None = None) -> CopilotAction:
    """keep / undo an applied action; accept / dismiss a proposal; edit replaces the items of a draft."""
    now = datetime.now(timezone.utc)
    if decision == "edit":
        if a.kind != "questions" or items is None:
            raise ValueError("Only drafted questions can be edited here")
        a.items = [{"label": str(i.get("label", "")).strip()[:300]} for i in items if str(i.get("label", "")).strip()][:8]
        a.status = "kept"
    elif decision == "keep":
        a.status = "kept"
    elif decision == "undo":
        if a.kind == "reminders":
            for r in db.exec(select(Reminder).where(col(Reminder.id).in_(a.ref_ids))).all():
                r.status = "removed"
                db.add(r)
        elif a.kind == "reminders_stopped":
            for r in db.exec(select(Reminder).where(col(Reminder.id).in_(a.ref_ids))).all():
                r.status, r.end_date = "active", None
                db.add(r)
        elif a.kind == "appointment":
            for ap in db.exec(select(Appointment).where(col(Appointment.id).in_(a.ref_ids))).all():
                ap.status = "cancelled"
                db.add(ap)
        a.status = "rejected"
    elif decision == "accept":
        if a.kind == "test_due":
            item = a.items[0] if a.items else {}
            due = max(date.fromisoformat(item.get("detail") or now_ist().date().isoformat()), now_ist().date() + timedelta(days=7))
            ap = Appointment(patient_id=a.patient_id, kind="test", title=item.get("label") or a.title, due_date=due,
                             source="copilot", source_text=a.detail)
            db.add(ap)
            db.flush()
            a.ref_ids = [ap.id]
        elif a.kind == "overdue":
            for ap in db.exec(select(Appointment).where(col(Appointment.id).in_(a.ref_ids))).all():
                ap.status = "done"
                db.add(ap)
        a.status = "accepted"
    elif decision == "dismiss":
        a.status = "rejected"
    else:
        raise ValueError("Unknown decision")
    a.resolved_at = now
    db.add(a)
    db.commit()
    db.refresh(a)
    return a
