from datetime import date, datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app import demo
from app.models.tables import Account, Appointment, CopilotAction, DoseLog, MedicationRequest, Patient, Reminder
from app.services import agent, care, reminders, scheduler, wellness
from app.services.reminders import IST, now_ist

TODAY = now_ist().date()


def at(h: int, m: int = 0) -> datetime:
    return datetime(TODAY.year, TODAY.month, TODAY.day, h, m, tzinfo=IST)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture()
def family(db):
    acc = demo.build(db, today=TODAY)
    return acc, {p.relationship: p for p in db.exec(select(Patient).where(Patient.owner_id == acc.id)).all()}


def _med(**kw) -> MedicationRequest:
    base = dict(patient_id="p", name_raw="x", name="Glycomet", strength="500 mg", form="tablet", authored_on=TODAY)
    return MedicationRequest(**(base | kw))


def test_slots_follow_the_prescription():
    assert [s["time"] for s in reminders.slots_for(_med(morning=1, night=1, meal_relation="after_food"))] == ["08:00", "21:00"]
    assert [s["time"] for s in reminders.slots_for(_med(morning=1, meal_relation="before_food"))] == ["07:30"]
    assert [s["time"] for s in reminders.slots_for(_med(morning=1, meal_relation="empty_stomach"))] == ["07:00"]
    assert [s["time"] for s in reminders.slots_for(_med(frequency_code="HS"))] == ["22:00"]
    assert [s["time"] for s in reminders.slots_for(_med(frequency_code="TDS"))] == ["08:00", "14:00", "21:00"]
    assert reminders.slots_for(_med(frequency_code="SOS")) == []
    assert reminders.slots_for(_med(morning=0.5, afternoon=0, night=0))[0]["amount"] == "½ tablet"


def test_follow_ups_are_read_from_notes():
    from app.models.tables import Document

    doc = Document(patient_id="p", filename="x", mime_type="x", file_path="", document_date=TODAY, author="Dr. Rao",
                   review={"document": {"follow_up": "Review after 2 weeks with FBS report",
                                        "advice": ["Repeat HbA1c after 3 months", "Walk daily", "Recheck TSH in 6 weeks"]}})
    got = {(f["kind"], f["due_date"]) for f in reminders.follow_ups_in(doc)}
    assert got == {("visit", TODAY + timedelta(days=14)), ("test", TODAY + timedelta(days=90)), ("test", TODAY + timedelta(days=42))}
    titles = [f["title"] for f in reminders.follow_ups_in(doc)]
    assert "Follow-up visit with Dr. Rao (bring FBS report)" in titles and "Repeat HbA1c" in titles


def test_demo_family_copilot_scenarios(db, family):
    _, by_rel = family
    father, mother, me = by_rel["father"], by_rel["mother"], by_rel["self"]

    # A new prescription schedules reminders and drafts questions; the as-needed medicine gets no reminder.
    mine = db.exec(select(Reminder).where(Reminder.patient_id == me.id)).all()
    assert sorted(r.title for r in mine) == ["Azee 500 mg", "Pan 40 mg"]
    assert all(r.end_date == TODAY - timedelta(days=3) + timedelta(days=4) for r in mine)
    kinds = {a.kind for a in db.exec(select(CopilotAction).where(CopilotAction.patient_id == me.id)).all()}
    assert {"reminders", "questions"} <= kinds

    # Father: HbA1c above range across three reports, flagged as a trend, with the repeat test overdue.
    prof = care.build_profile(db, father)
    keys = {i["key"]: i for i in care.insights(prof)}
    assert "persistent:hba1c" in keys and "rising" in keys["persistent:hba1c"]["body"]
    assert len(keys["persistent:hba1c"]["evidence"]) == 3
    assert "combo:sugar_ldl" in keys and "combo:kidney" in keys
    appts = list(db.exec(select(Appointment).where(Appointment.patient_id == father.id)).all())
    due = {i["title"]: i for i in care.preventive(prof, appts, TODAY)}
    assert due["Repeat HbA1c"]["status"] == "overdue"
    assert "HbA1c (3-month sugar average)" not in due  # the doctor's own "repeat HbA1c" covers it
    overdue = db.exec(select(CopilotAction).where(CopilotAction.patient_id == father.id, CopilotAction.kind == "overdue",
                                                  CopilotAction.status == "proposed")).all()
    assert len(overdue) == 2

    # Mother: iron pattern and thyroid on treatment; night-time reminders exist for the Telugu voice question.
    mkeys = {i["key"] for i in care.insights(care.build_profile(db, mother))}
    assert {"combo:iron_pattern", "combo:thyroid_treated"} <= mkeys
    night = [d for d in reminders.doses_for_day(db, [mother], TODAY, at(9)) if d["slot"] == "night"]
    assert {d["title"] for d in night} == {"Orofer XT 100 mg", "Shelcal 500 mg"}


def test_wording_is_never_a_diagnosis(db, family):
    banned = ("you have ", "you are diabetic", "stop taking", "increase your dose", "reduce your dose", "diagnos")
    for p in family[1].values():
        prof = care.build_profile(db, p)
        texts = [x for i in care.insights(prof) for x in (i["title"], i["body"], i.get("next_step") or "")]
        texts += [t["body"] + t["why"] for t in wellness.recommendations(prof)]
        for t in texts:
            assert not any(b in t.lower() for b in banned), t


def test_dose_actions_and_adherence(db, family):
    father = family[1]["father"]
    r = db.exec(select(Reminder).where(Reminder.patient_id == father.id, Reminder.title == "Glycomet 500 mg")).one()
    t0 = at(8, 5)
    doses = [d for d in reminders.doses_for_day(db, [father], TODAY, t0) if d["reminder_id"] == r.id]
    assert [(d["time"], d["status"]) for d in doses] == [("08:00", "due"), ("21:00", "pending")]
    reminders.record_dose(db, r, TODAY, "08:00", "taken")
    assert reminders.doses_for_day(db, [father], TODAY, t0)[0]["status"] in ("taken", "due")
    assert [d["status"] for d in reminders.doses_for_day(db, [father], TODAY, t0) if d["reminder_id"] == r.id] == ["taken", "pending"]
    with pytest.raises(ValueError):
        reminders.record_dose(db, r, TODAY, "09:00", "taken")
    a = reminders.adherence(db, father, today=TODAY)
    assert a["scheduled"] > 0 and 60 <= a["percent"] < 100


def test_due_now_respects_window_and_snooze(db, family):
    acc, by_rel = family
    father = by_rel["father"]
    r = db.exec(select(Reminder).where(Reminder.patient_id == father.id, Reminder.title == "Glycomet 500 mg")).one()
    early, on_time, late = at(7, 50), at(8, 10), at(9, 30)
    titles = lambda now: {d["title"] for d in scheduler.due_now(db, acc, now)}  # noqa: E731
    assert "Glycomet 500 mg" not in titles(early)
    assert "Glycomet 500 mg" in titles(on_time)
    assert "Glycomet 500 mg" not in titles(late)
    reminders.record_dose(db, r, TODAY, "08:00", "snoozed", minutes=5)
    lg = db.exec(select(DoseLog).where(DoseLog.reminder_id == r.id, DoseLog.day == TODAY)).one()
    lg.snooze_until = at(8, 15).astimezone(timezone.utc).replace(tzinfo=None)
    db.add(lg)
    db.commit()
    assert "Glycomet 500 mg" not in titles(on_time)
    assert "Glycomet 500 mg" in titles(at(9, 30))


def test_undo_and_accept(db, family):
    me = family[1]["self"]
    act = db.exec(select(CopilotAction).where(CopilotAction.patient_id == me.id, CopilotAction.kind == "reminders")).one()
    agent.resolve(db, act, "undo")
    assert {r.status for r in db.exec(select(Reminder).where(Reminder.patient_id == me.id)).all()} == {"removed"}
    reminders.sync_medicine_reminders(db, me.id, TODAY)  # removed reminders are never re-created
    assert {r.status for r in db.exec(select(Reminder).where(Reminder.patient_id == me.id)).all()} == {"removed"}

    father = family[1]["father"]
    od = db.exec(select(CopilotAction).where(CopilotAction.patient_id == father.id, CopilotAction.kind == "overdue")).first()
    agent.resolve(db, od, "accept")
    assert db.get(Appointment, od.ref_ids[0]).status == "done"

    q = db.exec(select(CopilotAction).where(CopilotAction.patient_id == father.id, CopilotAction.kind == "questions",
                                            CopilotAction.status == "done")).one()
    agent.resolve(db, q, "edit", [{"label": "What should my HbA1c target be?"}, {"label": " "}])
    assert q.items == [{"label": "What should my HbA1c target be?"}] and q.status == "kept"


def test_api_flow():
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool

    from app.db import get_session
    from app.main import app

    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)

    def session():
        with Session(eng) as s:
            yield s

    app.dependency_overrides[get_session] = session
    try:
        with Session(eng) as s:
            demo.build(s, login="care-test@example.com", password="secret123", name="Care Test")
            demo.build(s, login="other-care@example.com", password="secret123", name="Other")
        c = TestClient(app)
        assert c.post("/api/auth/login", json={"login": "care-test@example.com", "password": "secret123"}).status_code == 200
        patients = c.get("/api/patients").json()
        father = next(p for p in patients if p["relationship"] == "father")
        today = c.get("/api/today").json()
        assert {d["patient_name"] for d in today["doses"]} >= {"Ramesh Kumar"}
        d = next(x for x in today["doses"] if x["patient_name"] == "Ramesh Kumar")
        r = c.post(f"/api/reminders/{d['reminder_id']}/doses", json={"day": today["day"], "time": d["time"], "action": "taken"})
        assert r.json()["status"] == "taken"
        ov = c.get(f"/api/patients/{father['id']}/care").json()
        assert ov["insights"] and ov["preventive"] and ov["wellness"] and ov["disclaimer"]
        feed = c.get(f"/api/patients/{father['id']}/copilot").json()
        assert any(a["kind"] == "questions" for a in feed)
        prep = c.get(f"/api/patients/{father['id']}/visit-prep").json()
        assert len(prep["questions"]) == 3 and prep["medications"]
        rem = c.get(f"/api/patients/{father['id']}/reminders").json()
        rid = rem["reminders"][0]["id"]
        assert c.patch(f"/api/reminders/{rid}", json={"slots": [{"time": "25:00"}]}).status_code == 400
        ok = c.patch(f"/api/reminders/{rid}", json={"slots": [{"time": "09:15", "amount": "1 tablet"}], "status": "paused"}).json()
        assert ok["status"] == "paused" and ok["slots"][0]["time"] == "09:15"
        due = (TODAY + timedelta(days=9)).isoformat()
        assert c.post(f"/api/patients/{father['id']}/appointments", json={"title": "Eye check", "due_date": due}).status_code == 200

        # another account can neither see nor change them
        c2 = TestClient(app)
        c2.post("/api/auth/login", json={"login": "other-care@example.com", "password": "secret123"})
        assert c2.patch(f"/api/reminders/{rid}", json={"status": "active"}).status_code == 404
        assert c2.get(f"/api/patients/{father['id']}/care").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_every_language_has_safety_and_notification_text():
    import json
    from pathlib import Path

    from app.services.safety import CRITICAL_BANNER, DISCLAIMER, EMERGENCY_NOTICE, LANGUAGES
    from app.services.scheduler import MEAL, TEXT

    for lang in LANGUAGES:
        for table in (DISCLAIMER, CRITICAL_BANNER, EMERGENCY_NOTICE, TEXT):
            assert lang in table, lang
        assert "112" in DISCLAIMER[lang] and "112" in EMERGENCY_NOTICE[lang]
        assert TEXT[lang]["dose"].format(title="X").count("X") == 1
        if lang != "en":
            assert set(MEAL[lang]) == {"after food", "before food", "with food", "on an empty stomach", "at bedtime"}
    ui = Path(__file__).resolve().parents[2] / "frontend/src/i18n"
    if ui.is_dir():
        assert {f.stem for f in ui.glob("*.json")} == set(LANGUAGES)


def test_tonights_medicines_without_a_model(db, family, monkeypatch):
    from app.services import chat, quick_answers

    assert quick_answers.schedule_question("ఈ రాత్రి నేను ఏ మందులు వేసుకోవాలి?") == "night"
    assert quick_answers.schedule_question("आज सुबह कौन सी दवा लेनी है") == "morning"
    assert quick_answers.schedule_question("which medicines today?") == "today"
    assert quick_answers.schedule_question("is my sugar okay tonight") is None
    assert quick_answers.schedule_question("what does this medicine do?") is None

    def busy(*a, **k):
        raise chat.llm.LLMUnavailable("All models failed")

    monkeypatch.setattr(chat.llm, "parse", busy)
    mother = family[1]["mother"]
    r = chat.ask(db, mother, "ఈ రాత్రి నేను ఏ మందులు వేసుకోవాలి?", [], "en", voice=True)
    assert r["quick"] and r["reply_language"] == "te"
    assert r["answer"].startswith("ఈ రాత్రి మందులు") and "Orofer" in r["answer"] and "Thyronorm" not in r["answer"]
    assert {m["name"] for m in r["medications"]} >= {"Orofer XT"}
    with pytest.raises(chat.llm.LLMUnavailable):
        chat.ask(db, mother, "How is my thyroid?", [], "en")
