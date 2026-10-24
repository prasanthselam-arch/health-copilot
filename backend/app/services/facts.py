"""Compact, ID-tagged fact sheets that ground every summary and chat answer."""

from collections import defaultdict
from datetime import date
from typing import Any

from sqlmodel import Session, select

from app.knowledge import drugs, labs
from app.models.tables import Condition, Document, Encounter, MedicationRequest, Observation, Patient
from app.services.records import medication_status

FLAG_WORDS = {"N": "normal", "L": "low", "H": "high", "LL": "critically low", "HH": "critically high", "A": "abnormal"}


def _age(p: Patient) -> int | None:
    if not p.birth_date:
        return None
    t = date.today()
    return t.year - p.birth_date.year - ((t.month, t.day) < (p.birth_date.month, p.birth_date.day))


def num(v: float) -> float | int:
    """171.0 -> 171, so answers and cards read like the report."""
    return int(v) if float(v).is_integer() else v


def obs_fact(o: Observation) -> dict[str, Any]:
    entry = labs().by_loinc.get(o.loinc or "")
    f: dict[str, Any] = {
        "id": o.id, "test": o.name, "value": num(o.value_num) if o.value_num is not None else o.value_text, "unit": o.unit,
        "reference_range": o.ref_text, "range_source": o.ref_source,
        "flag": FLAG_WORDS.get(o.interpretation or "", None), "critical": o.critical,
        "date": o.effective_date.isoformat() if o.effective_date else None,
    }
    if entry:
        f["about"] = entry.what
        if o.interpretation in ("H", "HH") and entry.high:
            f["high_can_mean"] = entry.high
        if o.interpretation in ("L", "LL") and entry.low:
            f["low_can_mean"] = entry.low
    return {k: v for k, v in f.items() if v not in (None, "", False)}


def med_fact(m: MedicationRequest) -> dict[str, Any]:
    d, _, _ = drugs().match(m.name, m.generic)
    sched = [s for s, v in (("morning", m.morning), ("afternoon", m.afternoon), ("night", m.night)) if v]
    f = {
        "id": m.id, "name": m.name, "generic": m.generic, "strength": m.strength, "form": m.form,
        "schedule": (m.frequency_raw or "") + (f" ({', '.join(sched)})" if sched else ""),
        "frequency_code": m.frequency_code, "meal": (m.meal_relation or "").replace("_", " ") or None,
        "duration_days": m.duration_days, "instructions": m.instructions, "status": medication_status(m),
        "commonly_used_for": d.common_use if d else None, "drug_class": m.drug_class,
        "prescribed_on": m.authored_on.isoformat() if m.authored_on else None, "prescriber": m.prescriber,
    }
    return {k: v for k, v in f.items() if v not in (None, "", [])}


def cond_fact(c: Condition) -> dict[str, Any]:
    return {k: v for k, v in {
        "id": c.id, "name": c.name, "icd10": c.icd10, "status": c.verification_status,
        "recorded": c.recorded_date.isoformat() if c.recorded_date else None,
    }.items() if v}


def document_facts(db: Session, doc: Document) -> dict[str, Any]:
    review = doc.review or {}
    d = review.get("document", {})
    obs = db.exec(select(Observation).where(Observation.document_id == doc.id)).all()
    meds = db.exec(select(MedicationRequest).where(MedicationRequest.document_id == doc.id)).all()
    conds = db.exec(select(Condition).where(Condition.document_id == doc.id)).all()
    enc = db.exec(select(Encounter).where(Encounter.document_id == doc.id)).first()
    facts: dict[str, Any] = {
        "document": {k: v for k, v in {
            "type": doc.doc_type, "title": doc.title, "date": doc.document_date.isoformat() if doc.document_date else None,
            "facility": doc.facility, "doctor": doc.author, "findings": d.get("findings"), "impression": d.get("impression"),
            "advice": d.get("advice"), "follow_up": d.get("follow_up"),
        }.items() if v},
        "conditions": [cond_fact(c) for c in conds],
        "results": [obs_fact(o) for o in obs],
        "medications": [med_fact(m) for m in meds],
    }
    if enc and enc.encounter_class == "IMP":
        facts["hospital_stay"] = {k: v for k, v in {
            "admitted": enc.start_date.isoformat() if enc.start_date else None,
            "discharged": enc.end_date.isoformat() if enc.end_date else None,
            "reason": enc.reason, "hospital_course": enc.hospital_course, "procedures": enc.procedures,
            "condition_at_discharge": enc.discharge_condition,
        }.items() if v}
    return facts


def trend_series(db: Session, patient_id: str) -> dict[str, list[Observation]]:
    rows = db.exec(select(Observation).where(Observation.patient_id == patient_id, Observation.value_num.is_not(None))).all()  # type: ignore[union-attr]
    series: dict[str, list[Observation]] = defaultdict(list)
    for o in rows:
        series[o.loinc or o.name.lower()].append(o)
    for k in series:
        series[k].sort(key=lambda o: (o.effective_date or date.min))
    return series


def patient_facts(db: Session, patient: Patient) -> dict[str, Any]:
    docs = db.exec(select(Document).where(Document.patient_id == patient.id, Document.status == "confirmed")).all()
    meds = db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient.id)).all()
    conds = db.exec(select(Condition).where(Condition.patient_id == patient.id)).all()
    seen: dict[str, Condition] = {}
    for c in sorted(conds, key=lambda c: c.recorded_date or date.min):
        seen[c.icd10 or c.name.lower()] = c
    latest, trends = [], []
    for key, series in trend_series(db, patient.id).items():
        last = series[-1]
        latest.append(obs_fact(last))
        if len(series) >= 2:
            prev = series[-2]
            change = (last.value_num or 0) - (prev.value_num or 0)
            pct = (change / prev.value_num * 100) if prev.value_num else None
            direction = "stable" if pct is not None and abs(pct) < 5 else ("up" if change > 0 else "down")
            trends.append({
                "test": last.name, "unit": last.unit,
                "points": [{"id": o.id, "date": o.effective_date.isoformat() if o.effective_date else None, "value": o.value_num,
                            "flag": FLAG_WORDS.get(o.interpretation or "")} for o in series[-6:]],
                "direction": direction, "change_percent": round(pct, 1) if pct is not None else None,
            })
    return {
        "patient": {k: v for k, v in {"gender": patient.gender, "age": _age(patient)}.items() if v},
        "records": {"documents": len(docs),
                    "first": min((d.document_date for d in docs if d.document_date), default=None),
                    "last": max((d.document_date for d in docs if d.document_date), default=None)},
        "conditions": [cond_fact(c) for c in seen.values()],
        "active_medications": [med_fact(m) for m in meds if medication_status(m) == "active"],
        "latest_results": latest,
        "abnormal_latest": [f for f in latest if f.get("flag") not in (None, "normal")],
        "trends": trends,
    }
