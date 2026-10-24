"""Demo family for judges and live demos, built through the same confirm path and copilot agent as real uploads.

    python -m app.demo                 # (re)build demo@healthcopilot.in / demo12345
    python -m app.demo --login x@y.z   # another account

The records are synthetic. Dates are relative to today so the timeline, trends and due tests always look current:
- Ravi (the account holder, 36) has a short antibiotic course from a prescription three days ago.
- His father Ramesh (64) has diabetes with HbA1c rising across three reports, an overdue repeat test and a missed
  follow-up visit.
- His mother Lakshmi (59, prefers Telugu) has thyroid and iron-deficiency patterns, with night-time medicines.
"""

import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from app.fhir import mapper
from app.models.tables import Account, Document, DoseLog, Patient, Reminder
from app.pipeline.validate import build_review
from app.schemas.extraction import DocumentExtraction
from app.services import agent, auth
from app.services.records import confirm, delete_patient
from app.services.reminders import IST, now_ist


def lab(name: str, value: float | str, unit: str | None, lo: float | None = None, hi: float | None = None,
        panel: str | None = None, category: str = "laboratory") -> dict[str, Any]:
    num = value if isinstance(value, (int, float)) else None
    ref = (f"{lo:g} - {hi:g}" if lo is not None and hi is not None else f"< {hi:g}" if hi is not None
           else f"> {lo:g}" if lo is not None else None)
    return {"category": category, "panel": panel, "test_name_as_written": name, "test_name": name,
            "value_as_written": str(value), "value_numeric": num, "unit": unit, "reference_range_as_written": ref,
            "ref_low": lo, "ref_high": hi, "flag_on_report": None, "confidence": 1.0, "page": 1}


def med(name: str, generic: str, strength: str, freq: str, m: float, a: float, n: float, meal: str | None,
        days: int | None = None, form: str = "tablet", dose: str = "1 tablet", instructions: str | None = None) -> dict[str, Any]:
    return {"name_as_written": f"Tab {name} {strength}", "name": name, "generic_name": generic, "strength": strength, "form": form,
            "dose": dose, "frequency_as_written": freq, "morning": m, "afternoon": a, "night": n, "meal_relation": meal,
            "route": "oral", "duration_as_written": f"x {days} days" if days else None, "duration_days": days,
            "instructions": instructions, "confidence": 1.0, "page": 1}


def dx(text: str, name: str, icd: str) -> dict[str, Any]:
    return {"text_as_written": text, "name": name, "icd10": icd, "status": "confirmed", "confidence": 1.0, "page": 1}


def extraction(doc_type: str, facility: str, doctor: str | None, *, tests=(), meds=(), diagnoses=(), advice=(),
               follow_up: str | None = None) -> dict[str, Any]:
    return {"document_type": doc_type, "facility_name": facility, "doctor_name": doctor, "doctor_registration": None,
            "patient": {"name": None, "age": None, "gender": None, "patient_identifier": None, "abha_number": None},
            "diagnoses": list(diagnoses), "medications": list(meds), "tests": list(tests), "encounter": None,
            "findings": None, "impression": None, "advice": list(advice), "follow_up": follow_up, "unreadable": [],
            "legibility": "good"}


def add_record(db: Session, patient: Patient, title: str, days_ago: int, ex: dict[str, Any], today: date | None = None) -> Document:
    """Store a record as if it had been uploaded, reviewed and confirmed, then let the copilot act on it."""
    today = today or now_ist().date()
    when = today - timedelta(days=days_ago)
    e = DocumentExtraction.model_validate({**ex, "document_date": when.isoformat(), "document_date_as_written": when.strftime("%d/%m/%Y")})
    doc = Document(id=mapper.stable_id("demo-record", patient.id, title), patient_id=patient.id, filename=f"{title}.json",
                   mime_type="application/json", file_path="", source="demo", doc_type=e.document_type.value, title=title,
                   languages=["en"])
    db.add(doc)
    db.commit()
    payload = build_review(e, None, patient.gender)
    payload.document.title = title
    confirm(db, doc, payload)
    created = datetime.combine(when, time(11, 0), IST).astimezone(timezone.utc)
    doc.created_at = doc.confirmed_at = created
    db.add(doc)
    db.commit()
    for a in agent.after_confirm(db, doc):
        a.created_at = created
        db.add(a)
    db.commit()
    return doc


def _birth(years: int, today: date) -> date:
    return date(today.year - years, max(1, today.month - 2), 14)


def _profile(db: Session, acc: Account, name: str, rel: str, gender: str, age: int, lang: str, today: date) -> Patient:
    p = Patient(owner_id=acc.id, name=name, relationship=rel, gender=gender, birth_date=_birth(age, today), preferred_language=lang)
    p.fhir_json = mapper.patient_resource(p)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _history(db: Session, patient: Patient, today: date, missed: set[tuple[int, str]]) -> None:
    """A week of dose history so adherence has something to show: most doses taken, a few missed."""
    for r in db.exec(select(Reminder).where(Reminder.patient_id == patient.id, Reminder.status == "active")).all():
        for back in range(1, 8):
            day = today - timedelta(days=back)
            if day < r.start_date or (r.end_date and day > r.end_date) or (r.weekdays and day.weekday() not in r.weekdays):
                continue
            for s in r.slots:
                if (back, s["slot"]) in missed:
                    continue
                at = datetime.combine(day, time(*map(int, s["time"].split(":"))), IST) + timedelta(minutes=12)
                db.add(DoseLog(reminder_id=r.id, patient_id=patient.id, day=day, time=s["time"], status="taken",
                               acted_at=at.astimezone(timezone.utc)))
    db.commit()


def build(db: Session, login: str = "demo@healthcopilot.in", password: str = "demo12345", name: str = "Ravi Kumar",
          today: date | None = None) -> Account:
    today = today or now_ist().date()
    acc = db.exec(select(Account).where(Account.login == login.lower())).first()
    if acc is None:
        acc = Account(login=login.lower(), name=name, password_hash=auth.hash_password(password), email=login.lower(),
                      email_verified_at=datetime.now(timezone.utc))
    acc.name = name
    acc.password_hash = auth.hash_password(password)
    db.add(acc)
    db.commit()
    for p in db.exec(select(Patient).where(Patient.owner_id == acc.id)).all():
        delete_patient(db, p)

    ravi = _profile(db, acc, name, "self", "male", 36, "en", today)
    ramesh = _profile(db, acc, "Ramesh Kumar", "father", "male", 64, "hi", today)
    lakshmi = _profile(db, acc, "Lakshmi Kumar", "mother", "female", 59, "te", today)

    # Father: diabetes with HbA1c rising across three reports, an overdue repeat test and a missed follow-up.
    for days, a1c, fbg, ldl, tg, hdl, cr, egfr in ((280, 7.4, 142, 128, 168, 41, 1.1, 74), (190, 7.9, 156, 134, 182, 39, 1.2, 66),
                                                   (105, 8.6, 171, 141, 196, 37, 1.4, 54)):
        add_record(db, ramesh, f"Diabetes & kidney panel ({(today - timedelta(days=days)):%b %Y})", days, extraction(
            "lab_report", "Apollo Diagnostics, Hyderabad", "Dr. S. Rao (Pathologist)", tests=[
                lab("HbA1c", a1c, "%", 4.0, 5.6, "Blood Sugar"), lab("Fasting Blood Sugar", fbg, "mg/dL", 70, 99, "Blood Sugar"),
                lab("LDL Cholesterol", ldl, "mg/dL", None, 100, "Lipid Profile"), lab("Triglycerides", tg, "mg/dL", None, 150, "Lipid Profile"),
                lab("HDL Cholesterol", hdl, "mg/dL", 40, None, "Lipid Profile"),
                lab("Serum Creatinine", cr, "mg/dL", 0.7, 1.3, "Kidney Function"), lab("eGFR", egfr, "mL/min/1.73m2", 90, None, "Kidney Function"),
            ]), today)
    add_record(db, ramesh, "Diabetes clinic prescription", 100, extraction(
        "prescription", "Sunrise Diabetes Clinic, Hyderabad", "Dr. Anil Mehta",
        diagnoses=[dx("T2DM", "Type 2 diabetes mellitus", "E11.9"), dx("HTN", "Hypertension", "I10"),
                   dx("Dyslipidemia", "Dyslipidemia", "E78.5")],
        meds=[med("Glycomet", "Metformin", "500 mg", "1-0-1", 1, 0, 1, "after_food"),
              med("Amaryl", "Glimepiride", "1 mg", "1-0-0", 1, 0, 0, "before_food"),
              med("Telma", "Telmisartan", "40 mg", "1-0-0", 1, 0, 0, "after_food"),
              med("Atorva", "Atorvastatin", "10 mg", "0-0-1", 0, 0, 1, "after_food")],
        tests=[lab("Blood Pressure", "146/92", "mmHg", category="vital-signs"), lab("Weight", 81, "kg", category="vital-signs")],
        advice=["Walk 30 minutes daily", "Avoid sweets and sugary drinks", "Repeat HbA1c after 3 months"],
        follow_up="Review after 1 month with fasting sugar report"), today)
    _history(db, ramesh, today, missed={(2, "night"), (4, "morning"), (5, "night")})

    # Mother: thyroid and iron-deficiency patterns, prefers Telugu, takes medicines at night.
    add_record(db, lakshmi, "Thyroid & blood count", 210, extraction(
        "lab_report", "Vijaya Diagnostics, Hyderabad", None, tests=[
            lab("Hemoglobin", 10.9, "g/dL", 12.0, 15.5, "Complete Blood Count"), lab("MCV", 78, "fL", 83, 101, "Complete Blood Count"),
            lab("TSH", 5.9, "uIU/mL", 0.4, 4.5, "Thyroid"), lab("Vitamin D", 18, "ng/mL", 30, 100, "Vitamins")]), today)
    add_record(db, lakshmi, "Thyroid, iron & vitamin panel", 40, extraction(
        "lab_report", "Vijaya Diagnostics, Hyderabad", None, tests=[
            lab("Hemoglobin", 10.2, "g/dL", 12.0, 15.5, "Complete Blood Count"), lab("MCV", 74, "fL", 83, 101, "Complete Blood Count"),
            lab("Serum Ferritin", 9, "ng/mL", 13, 150, "Iron Studies"), lab("TSH", 6.8, "uIU/mL", 0.4, 4.5, "Thyroid"),
            lab("Vitamin D", 14, "ng/mL", 30, 100, "Vitamins")]), today)
    add_record(db, lakshmi, "Physician prescription", 35, extraction(
        "prescription", "Care Clinic, Kukatpally", "Dr. Padma Reddy",
        diagnoses=[dx("Hypothyroidism", "Hypothyroidism", "E03.9"), dx("IDA", "Iron deficiency anaemia", "D50.9")],
        meds=[med("Thyronorm", "Levothyroxine", "50 mcg", "1-0-0 empty stomach", 1, 0, 0, "empty_stomach"),
              med("Orofer XT", "Ferrous ascorbate + Folic acid", "100 mg", "0-0-1", 0, 0, 1, "after_food", days=90),
              med("Shelcal", "Calcium carbonate + Vitamin D3", "500 mg", "0-0-1", 0, 0, 1, "after_food", days=60)],
        advice=["Green leafy vegetables daily", "Repeat CBC and TSH after 6 weeks"],
        follow_up="Review after 6 weeks with CBC, TSH"), today)
    _history(db, lakshmi, today, missed={(3, "night")})

    # Account holder: a short antibiotic course from three days ago and an older routine check-up.
    add_record(db, ravi, "Annual health check-up", 160, extraction(
        "lab_report", "Thyrocare, Hyderabad", None, tests=[
            lab("Hemoglobin", 14.6, "g/dL", 13.0, 17.0, "Complete Blood Count"), lab("Fasting Blood Sugar", 96, "mg/dL", 70, 99, "Blood Sugar"),
            lab("HbA1c", 5.8, "%", 4.0, 5.6, "Blood Sugar"), lab("LDL Cholesterol", 118, "mg/dL", None, 100, "Lipid Profile"),
            lab("Vitamin D", 21, "ng/mL", 30, 100, "Vitamins"), lab("Vitamin B12", 410, "pg/mL", 200, 900, "Vitamins")]), today)
    add_record(db, ravi, "Fever prescription", 3, extraction(
        "prescription", "City Clinic, Madhapur", "Dr. K. Sharma", diagnoses=[dx("URTI", "Acute upper respiratory infection", "J06.9")],
        meds=[med("Azee", "Azithromycin", "500 mg", "1-0-0", 1, 0, 0, "after_food", days=5),
              med("Pan", "Pantoprazole", "40 mg", "1-0-0", 1, 0, 0, "before_food", days=5),
              med("Dolo", "Paracetamol", "650 mg", "SOS", 0, 0, 0, None, instructions="Only if fever above 100 F")],
        advice=["Drink plenty of warm fluids", "Rest"], follow_up="Review after 5 days if fever persists"), today)
    _history(db, ravi, today, missed=set())
    return acc


def main() -> int:
    from app.db import engine, init_db

    ap = argparse.ArgumentParser()
    ap.add_argument("--login", default="demo@healthcopilot.in")
    ap.add_argument("--password", default="demo12345")
    ap.add_argument("--name", default="Ravi Kumar")
    args = ap.parse_args()
    init_db()
    with Session(engine) as db:
        acc = build(db, args.login, args.password, args.name)
        names = [p.name for p in db.exec(select(Patient).where(Patient.owner_id == acc.id)).all()]
    print(f"demo account {args.login} ready with profiles: {', '.join(names)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
