"""Persist a user-confirmed ReviewPayload into FHIR-shaped tables."""

import logging
import shutil
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

from sqlmodel import Session, delete, select

from app.config import get_settings
from app.fhir import mapper
from app.models.tables import (
    AbhaSession,
    Appointment,
    Condition,
    CopilotAction,
    DoseLog,
    Reminder,
    DiagnosticReport,
    Document,
    Encounter,
    MedicationRequest,
    Observation,
    Patient,
    Summary,
)
from app.schemas.review import ReviewPayload

log = logging.getLogger(__name__)


def _d(iso: str | None) -> date | None:
    try:
        return date.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def clear_document_records(db: Session, doc_id: str) -> None:
    for model in (Observation, DiagnosticReport, MedicationRequest, Condition, Encounter, Summary):
        db.exec(delete(model).where(model.document_id == doc_id))  # type: ignore[arg-type]


def delete_document(db: Session, doc: Document) -> None:
    clear_document_records(db, doc.id)
    db.delete(doc)
    reconcile_medications(db, doc.patient_id)  # an older prescription of a drug may be the latest again
    db.commit()
    folder = get_settings().storage_dir / doc.id
    shutil.rmtree(folder, ignore_errors=True)
    if doc.file_path and not Path(doc.file_path).resolve().is_relative_to(folder.resolve()):
        Path(doc.file_path).unlink(missing_ok=True)  # ABHA imports keep their bundle outside the document folder


def delete_patient(db: Session, patient: Patient) -> None:
    """Remove a profile with all its documents, uploaded files, clinical records and summaries."""
    for d in db.exec(select(Document).where(Document.patient_id == patient.id)).all():
        delete_document(db, d)
    for s in db.exec(select(Summary).where(Summary.patient_id == patient.id)).all():
        db.delete(s)
    db.exec(delete(AbhaSession).where(AbhaSession.patient_id == patient.id))  # type: ignore[arg-type]
    for model in (Reminder, DoseLog, Appointment, CopilotAction):
        db.exec(delete(model).where(model.patient_id == patient.id))  # type: ignore[arg-type]
    db.delete(patient)
    db.commit()


def confirm(db: Session, doc: Document, payload: ReviewPayload) -> dict[str, int]:
    patient = db.get(Patient, doc.patient_id)
    assert patient is not None
    clear_document_records(db, doc.id)
    d = payload.document
    doc_date = _d(d.document_date)
    doc_type = d.doc_type
    fhir_errors: list[str] = []

    def finish(row, res):
        fhir_errors.extend(mapper.validate_resource(res))
        row.fhir_json = res
        db.add(row)

    practitioner_id = mapper.stable_id("practitioner", d.author, d.author_registration or "") if d.author else None
    org_id = mapper.stable_id("organization", d.facility) if d.facility else None

    if payload.encounter or doc_type == "discharge_summary":
        e = payload.encounter
        enc = Encounter(
            patient_id=patient.id, document_id=doc.id, encounter_class="IMP",
            start_date=_d(e.start_date) if e else None, end_date=_d(e.end_date) if e else doc_date,
            facility=d.facility, practitioner=d.author, reason=e.reason if e else None,
            hospital_course=e.hospital_course if e else None, procedures=e.procedures if e else [],
            discharge_condition=e.discharge_condition if e else None, follow_up=d.follow_up, advice=d.advice,
        )
        finish(enc, mapper.encounter_resource(enc))
    elif doc_type == "prescription":
        enc = Encounter(
            patient_id=patient.id, document_id=doc.id, encounter_class="AMB", start_date=doc_date, end_date=doc_date,
            facility=d.facility, practitioner=d.author, reason=", ".join(c.name for c in payload.conditions) or None,
            follow_up=d.follow_up, advice=d.advice,
        )
        finish(enc, mapper.encounter_resource(enc))

    report = None
    labs = [o for o in payload.observations if o.category == "laboratory"]
    if labs or doc_type in ("lab_report", "imaging_report"):
        panels = list(dict.fromkeys(o.panel for o in labs if o.panel))
        report = DiagnosticReport(
            patient_id=patient.id, document_id=doc.id, category="RAD" if doc_type == "imaging_report" else "LAB",
            name=d.title or (", ".join(panels[:3]) if panels else None), issued=doc_date, performer=d.facility,
            conclusion=d.impression or d.findings,
        )
        db.add(report)

    obs_rows: list[Observation] = []
    for o in payload.observations:
        row = Observation(
            patient_id=patient.id, document_id=doc.id,
            report_id=report.id if (report and o.category == "laboratory") else None,
            category=o.category, name_raw=o.name_raw, name=o.name, loinc=o.loinc, panel=o.panel,
            value_num=o.value_num, value_text=o.value_text, unit=o.unit,
            value_original=o.value_original, unit_original=o.unit_original,
            ref_low=o.ref_low, ref_high=o.ref_high, ref_text=o.ref_text, ref_source=o.ref_source,
            interpretation=o.interpretation, critical=o.critical, effective_date=doc_date, confidence=o.confidence,
        )
        finish(row, mapper.observation_resource(row))
        obs_rows.append(row)
    if report:
        finish(report, mapper.diagnostic_report_resource(report, [r for r in obs_rows if r.report_id], org_id))

    today = date.today()
    for m in payload.medications:
        status = "active"
        if m.duration_days and doc_date and doc_date + timedelta(days=m.duration_days) < today:
            status = "completed"
        if m.frequency_code == "STAT":
            status = "completed"
        row = MedicationRequest(
            patient_id=patient.id, document_id=doc.id, name_raw=m.name_raw, name=m.name, generic=m.generic,
            drug_class=m.drug_class, strength=m.strength, form=m.form, dose=m.dose,
            frequency_raw=m.frequency_raw, frequency_code=m.frequency_code,
            morning=m.morning, afternoon=m.afternoon, night=m.night, meal_relation=m.meal_relation, route=m.route,
            duration_text=m.duration_text, duration_days=m.duration_days, instructions=m.instructions,
            prescriber=d.author, authored_on=doc_date, status=status, confidence=m.confidence,
        )
        finish(row, mapper.medication_request_resource(row, practitioner_id))

    for c in payload.conditions:
        row = Condition(
            patient_id=patient.id, document_id=doc.id, name_raw=c.name_raw, name=c.name, icd10=c.icd10,
            icd10_display=c.icd10_display, verification_status=c.verification_status, recorded_date=doc_date,
            confidence=c.confidence,
        )
        finish(row, mapper.condition_resource(row))

    if not patient.gender and d.patient.gender in ("male", "female", "other"):
        patient.gender = d.patient.gender
        patient.fhir_json = mapper.patient_resource(patient)
        db.add(patient)

    doc.review = payload.model_dump(mode="json")
    doc.doc_type = doc_type
    doc.document_date, doc.facility, doc.author = doc_date, d.facility, d.author
    doc.title = d.title or doc.title
    doc.status, doc.stage, doc.progress = "confirmed", "confirmed", 100
    doc.confirmed_at = datetime.now(timezone.utc)
    doc.fhir_json = mapper.document_reference_resource(doc)
    fhir_errors.extend(mapper.validate_resource(doc.fhir_json))
    doc.pipeline_log = [*(x for x in doc.pipeline_log or [] if x.get("stage") != "fhir"), {"stage": "fhir", "resources": len(obs_rows) + len(payload.medications) + len(payload.conditions),
                                                     "errors": fhir_errors[:10]}]
    if fhir_errors:
        log.warning("FHIR validation errors for %s: %s", doc.id, fhir_errors[:3])
    db.add(doc)
    reconcile_medications(db, patient.id)
    db.commit()
    return {"observations": len(obs_rows), "medications": len(payload.medications), "conditions": len(payload.conditions),
            "fhir_errors": len(fhir_errors)}


def medication_status(m: MedicationRequest, today: date | None = None) -> str:
    """A course with a known length is over once its days have passed, however long ago it was confirmed."""
    if m.status == "active" and m.duration_days and m.authored_on and m.authored_on + timedelta(days=m.duration_days) < (today or date.today()):
        return "completed"
    return m.status


def reconcile_medications(db: Session, patient_id: str) -> None:
    """Only the latest prescription of a drug stays active, whatever order documents were added in."""
    db.flush()
    rows = db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient_id)).all()
    latest: dict[str, date] = {}
    for m in rows:
        if m.generic and m.authored_on:
            key = m.generic.lower()
            latest[key] = max(latest.get(key, m.authored_on), m.authored_on)
    for m in rows:
        if not (m.generic and m.authored_on):
            continue
        newest = m.authored_on >= latest[m.generic.lower()]
        ended = m.frequency_code == "STAT" or medication_status(m.model_copy(update={"status": "active"})) == "completed"
        status = "active" if newest and not ended else "completed"
        if status != m.status:
            m.status = status
            m.fhir_json = {**(m.fhir_json or {}), "status": status}
            db.add(m)
