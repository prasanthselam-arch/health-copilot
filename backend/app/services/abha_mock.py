"""Mock ABDM flows: ABHA link via OTP, consent artefact, and health-record pull from a mock HIP.

Real ABDM integration needs sandbox credentials (gateway session, HIU registration and
Fidelius encryption). This mock mirrors the same steps and data shapes so the swap is local.
"""

import json
import random
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlmodel import Session

from app.config import get_settings
from app.fhir import mapper
from app.models.tables import AbhaSession, Document, Patient

ABHA_NUMBER_RE = re.compile(r"^\d{2}-?\d{4}-?\d{4}-?\d{4}$")
ABHA_ADDRESS_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._]{2,31}@(abdm|sbx)$")
MOCK_HIP = Path(__file__).resolve().parent.parent / "knowledge" / "mock_hip_records.json"


def format_abha(number: str) -> str:
    d = re.sub(r"\D", "", number)
    return f"{d[:2]}-{d[2:6]}-{d[6:10]}-{d[10:14]}"


def init_link(db: Session, patient: Patient, abha_number: str | None, abha_address: str | None) -> dict[str, Any]:
    if abha_number:
        if not ABHA_NUMBER_RE.match(abha_number.strip()):
            raise ValueError("ABHA number must be 14 digits (format XX-XXXX-XXXX-XXXX)")
        abha_number = format_abha(abha_number)
    if abha_address:
        abha_address = abha_address.strip().lower()
        if "@" not in abha_address:
            abha_address += "@abdm"
        if not ABHA_ADDRESS_RE.match(abha_address):
            raise ValueError("ABHA address must look like name@abdm")
    if not abha_number and not abha_address:
        raise ValueError("Provide an ABHA number or ABHA address")
    s = get_settings()
    sess = AbhaSession(patient_id=patient.id, abha_number=abha_number, abha_address=abha_address, otp=s.demo_otp)
    db.add(sess)
    db.commit()
    mobile = patient.phone or "98XXXXXX21"
    return {
        "txn_id": sess.txn_id,
        "message": f"OTP sent to the mobile number linked with ABHA (******{mobile[-2:]})",
        "demo_otp_hint": s.demo_otp,
        "auth_mode": "MOBILE_OTP",
    }


def confirm_link(db: Session, patient: Patient, txn_id: str, otp: str) -> dict[str, Any]:
    sess = db.get(AbhaSession, txn_id)
    if not sess or sess.patient_id != patient.id:
        raise ValueError("Unknown transaction")
    created = sess.created_at if sess.created_at.tzinfo else sess.created_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - created > timedelta(minutes=10):
        raise ValueError("OTP expired, please request a new one")
    if otp.strip() != sess.otp:
        raise ValueError("Incorrect OTP")
    sess.verified = True
    if not sess.abha_number:
        rnd = random.Random(sess.abha_address)
        sess.abha_number = format_abha("91" + "".join(str(rnd.randint(0, 9)) for _ in range(12)))
    patient.abha_number = sess.abha_number
    patient.abha_address = sess.abha_address or f"{re.sub(r'[^a-z0-9]', '', patient.name.lower())[:16] or 'user'}@abdm"
    patient.abha_linked_at = datetime.now(timezone.utc)
    patient.fhir_json = mapper.patient_resource(patient)
    db.add_all([sess, patient])
    db.commit()
    return {"linked": True, "abha_number": patient.abha_number, "abha_address": patient.abha_address,
            "profile": {"name": patient.name, "gender": patient.gender, "kyc_verified": True}}


def unlink(db: Session, patient: Patient) -> None:
    patient.abha_number = patient.abha_address = patient.abha_linked_at = None
    patient.fhir_json = mapper.patient_resource(patient)
    db.add(patient)
    db.commit()


def consent_artefact(patient: Patient, hi_types: list[str], date_from: date, date_to: date) -> dict[str, Any]:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    return {
        "consent_id": mapper.stable_id("consent", patient.id, now.isoformat()),
        "status": "GRANTED",
        "purpose": {"code": "PATRQT", "text": "Self requested"},
        "patient": {"id": patient.abha_address},
        "hiu": {"id": "HEALTH-COPILOT-HIU", "name": "Personal Health Copilot"},
        "hip": {"id": "MOCK-HIP-001", "name": "City Care Hospital (Mock HIP)"},
        "hi_types": hi_types,
        "permission": {"access_mode": "VIEW", "date_range": {"from": date_from.isoformat(), "to": date_to.isoformat()},
                       "data_erase_at": (now + timedelta(days=30)).isoformat(), "frequency": {"unit": "HOUR", "value": 1, "repeats": 0}},
        "granted_at": now.isoformat(),
    }


def build_hip_bundles(patient: Patient) -> list[dict[str, Any]]:
    """What the mock HIP returns: ABDM document Bundles generated from its own records."""
    from app.fhir.bundle import document_bundle
    from app.pipeline.validate import build_review
    from app.schemas.extraction import DocumentExtraction
    from app.services.records import confirm
    from sqlmodel import SQLModel, create_engine
    from sqlmodel import Session as S

    spec = json.loads(MOCK_HIP.read_text())
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    bundles = []
    today = date.today()
    with S(engine) as hip_db:
        hp = Patient(id=patient.id, name=patient.name, gender=patient.gender, abha_number=patient.abha_number,
                     abha_address=patient.abha_address, birth_date=patient.birth_date)
        hip_db.add(hp)
        hip_db.commit()
        for rec in spec["records"]:
            rec_date = today - timedelta(days=rec["days_ago"])
            ex = DocumentExtraction.model_validate({**rec["extraction"], "document_date": rec_date.isoformat(),
                                                    "document_date_as_written": rec_date.strftime("%d/%m/%Y")})
            d = Document(id=mapper.stable_id("hip-record", patient.id, rec["title"]),
                         patient_id=hp.id, filename=rec["title"] + ".json", mime_type="application/fhir+json",
                         file_path="", source="hip", doc_type=ex.document_type.value, title=rec["title"])
            hip_db.add(d)
            hip_db.commit()
            payload = build_review(ex, None, patient.gender)
            payload.document.title = rec["title"]
            confirm(hip_db, d, payload)
            bundles.append(document_bundle(hip_db, d))
    return bundles


def import_from_hip(db: Session, patient: Patient, hi_types: list[str]) -> dict[str, Any]:
    from app.fhir.bundle import bundle_to_extractions, validate_bundle
    from app.pipeline.validate import build_review
    from app.services.records import confirm, delete_document

    if not patient.abha_number:
        raise ValueError("Link an ABHA first")
    today = date.today()
    consent = consent_artefact(patient, hi_types, today - timedelta(days=730), today)
    bundles = build_hip_bundles(patient)
    type_map = {"Prescription": "prescription", "DiagnosticReport": "lab_report", "DischargeSummary": "discharge_summary"}
    wanted = {type_map[h] for h in hi_types if h in type_map}
    imported, errors = [], []
    storage = get_settings().storage_dir / "abdm"
    storage.mkdir(parents=True, exist_ok=True)
    for b in bundles:
        errs = validate_bundle(b)
        errors.extend(errs)
        for ex, meta in bundle_to_extractions(b):
            if wanted and ex.document_type.value not in wanted:
                continue
            path = storage / f"{b['id']}.json"
            path.write_text(json.dumps(b, indent=2, ensure_ascii=False))
            existing = db.get(Document, b["id"])
            if existing:
                delete_document(db, existing)
            doc = Document(id=b["id"], patient_id=patient.id, filename=f"{meta['title']}.json", mime_type="application/fhir+json",
                           file_path=str(path), source="abdm_import", doc_type=ex.document_type.value, title=meta["title"],
                           languages=["en"])
            db.add(doc)
            db.commit()
            payload = build_review(ex, None, patient.gender)
            payload.document.title = meta["title"]
            payload.document.facility = payload.document.facility or "City Care Hospital (Mock HIP)"
            confirm(db, doc, payload)
            from app.services import agent

            agent.after_confirm(db, doc)
            imported.append({"id": doc.id, "title": doc.title, "type": doc.doc_type,
                             "date": doc.document_date.isoformat() if doc.document_date else None})
    return {"consent": consent, "imported": imported, "fhir_validation_errors": errors[:10], "bundles": len(bundles)}
