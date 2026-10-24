"""Orchestrates preprocess -> classify -> extract -> validate -> verify -> review."""

import logging
import shutil
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.config import get_settings
from app.db import engine
from app.models.tables import Document, Patient
from app.pipeline import extract as ex
from app.pipeline.preprocess import prepare
from app.pipeline.validate import build_review, suspicious_paths
from app.schemas.extraction import Classification, DocumentExtraction, VerificationResult
from app.schemas.review import Issue

log = logging.getLogger(__name__)
_pool: ThreadPoolExecutor | None = None


def pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(max_workers=get_settings().worker_threads, thread_name_prefix="pipeline")
    return _pool


def submit(doc_id: str) -> None:
    pool().submit(_safe_process, doc_id)


def resume_pending() -> None:
    with Session(engine) as s:
        for d in s.exec(select(Document).where(Document.status.in_(["queued", "processing"]))).all():  # type: ignore[attr-defined]
            submit(d.id)


def doc_dir(doc_id: str) -> Path:
    return get_settings().storage_dir / doc_id


class _Deleted(Exception):
    """The document was deleted while it was being processed."""


def _gone(db: Session, doc_id: str) -> bool:
    with db.no_autoflush:  # flushing the pending progress first would fail on a deleted row
        return db.exec(select(Document.id).where(Document.id == doc_id)).first() is None


def _save(db: Session, doc: Document, doc_id: str) -> None:
    """Commit progress, or stop if the user deleted the document in the meantime."""
    if _gone(db, doc_id):
        raise _Deleted
    db.add(doc)
    try:
        db.commit()
        db.refresh(doc)
    except SQLAlchemyError:
        db.rollback()
        if _gone(db, doc_id):
            raise _Deleted from None
        raise


def _safe_process(doc_id: str) -> None:
    try:
        process_document(doc_id)
    except Exception:  # noqa: BLE001
        log.exception("pipeline crashed for %s", doc_id)


def process_document(doc_id: str) -> None:
    s = get_settings()
    with Session(engine) as db:
        doc = db.get(Document, doc_id)
        if doc is None:
            return
        patient = db.get(Patient, doc.patient_id)
        sex = patient.gender if patient else None
        doc.pipeline_log = []
        doc.error = None

        def step(stage: str, progress: int) -> None:
            doc.status, doc.stage, doc.progress = "processing", stage, progress
            _save(db, doc, doc_id)

        def record(stage: str, t0: float, **extra: Any) -> None:
            doc.pipeline_log = [*doc.pipeline_log, {"stage": stage, "ms": int((time.perf_counter() - t0) * 1000), **extra}]

        try:
            step("preprocessing", 8)
            t0 = time.perf_counter()
            prepared = prepare(Path(doc.file_path), doc.mime_type, doc_dir(doc.id) / "pages")
            doc.page_images = [p.name for p in prepared.pages]
            doc.page_count = len(prepared.pages)
            record("preprocessing", t0, pages=len(prepared.pages), text_layer=prepared.has_text_layer, notes=prepared.notes)

            step("classifying", 18)
            t0 = time.perf_counter()
            r = ex.classify(prepared)
            cls: Classification = r.parsed
            doc.classification = cls.model_dump(mode="json")
            doc.doc_type, doc.languages, doc.handwritten, doc.title = cls.document_type.value, cls.languages, cls.handwritten, cls.title
            turned = ex.orient(prepared, cls)
            record("classifying", t0, model=r.model, tokens=r.input_tokens + r.output_tokens, **({"note": turned} if turned else {}))

            step("extracting", 32)
            t0 = time.perf_counter()
            r = ex.extract(prepared, cls)
            first: DocumentExtraction = r.parsed
            doc.raw_extraction = first.model_dump(mode="json")
            record("extracting", t0, model=r.model, tokens=r.input_tokens + r.output_tokens)

            step("validating", 55)
            t0 = time.perf_counter()
            hints = suspicious_paths(first, sex)
            record("validating", t0, flagged=len(hints))

            final, vr = first, None
            extra_issues: list[Issue] = []
            clean = not cls.handwritten and getattr(cls.legibility, "value", cls.legibility) == "good" and not hints
            if s.enable_verification and clean and not s.verify_clean_prints:
                record("verifying", time.perf_counter(), note="skipped: clearly printed and passed every check")
            elif s.enable_verification:
                step("verifying", 65)
                t0 = time.perf_counter()
                try:
                    r = ex.verify(prepared, first, hints, cls)
                    vr = r.parsed
                    final = vr.corrected
                    doc.verified_extraction = vr.model_dump(mode="json")
                    record("verifying", t0, model=r.model, tokens=r.input_tokens + r.output_tokens,
                           corrections=len(vr.corrections), added=len(vr.items_added), removed=len(vr.items_removed))
                except Exception as e:  # noqa: BLE001
                    log.warning("verification failed for %s: %s", doc.id, e)
                    record("verifying", t0, error=str(e)[:300])
                    extra_issues.append(Issue(level="warning", code="verification_unavailable",
                                              message="The second verification read could not run; please review values carefully"))

            step("finalizing", 92)
            t0 = time.perf_counter()
            payload = build_review(final, cls, sex, first if vr else None, vr)
            payload.issues = [*extra_issues, *payload.issues]
            if vr and vr.items_removed:
                payload.issues.append(Issue(level="info", code="removed_by_verifier",
                                            message="Removed as not present on the document: " + "; ".join(vr.items_removed[:6])))
            doc.review = payload.model_dump(mode="json")
            doc.document_date = _to_date(payload.document.document_date)
            doc.facility, doc.author = payload.document.facility, payload.document.author
            doc.title = doc.title or payload.document.title
            record("finalizing", t0, items=payload.stats.items_total, needs_review=payload.stats.needs_review)

            doc.status, doc.stage, doc.progress = "review", "review", 100
        except _Deleted:
            pass
        except Exception as e:  # noqa: BLE001
            if not _gone(db, doc_id):  # a deleted document's files vanish mid-run; that is not a failure
                log.error("pipeline failed for %s: %s\n%s", doc_id, e, traceback.format_exc())
                doc.status, doc.stage, doc.error = "failed", "failed", str(e)[:800]
        try:
            _save(db, doc, doc_id)
        except _Deleted:
            log.info("document %s was deleted while processing", doc_id)
            shutil.rmtree(doc_dir(doc_id), ignore_errors=True)


def _to_date(iso: str | None):
    from datetime import date

    try:
        return date.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def run_on_file(path: Path, mime: str, sex: str | None = None, verify: bool = True, work_dir: Path | None = None) -> dict[str, Any]:
    """Run the full pipeline without the database (used by the evaluation harness)."""
    work_dir = work_dir or Path("/tmp/healthcopilot") / path.stem
    prepared = prepare(path, mime, work_dir)
    timings: dict[str, int] = {}
    models: dict[str, str] = {}
    t0 = time.perf_counter()
    r = ex.classify(prepared)
    cls, models["classify"] = r.parsed, r.model
    ex.orient(prepared, cls)
    timings["classify"] = int((time.perf_counter() - t0) * 1000)
    t0 = time.perf_counter()
    r = ex.extract(prepared, cls)
    first, models["extract"] = r.parsed, r.model
    timings["extract"] = int((time.perf_counter() - t0) * 1000)
    single = build_review(first, cls, sex)
    out: dict[str, Any] = {"classification": cls, "first": first, "single": single, "timings": timings, "models": models}
    if verify:
        t0 = time.perf_counter()
        try:
            r = ex.verify(prepared, first, suspicious_paths(first, sex), cls)
            vr: VerificationResult = r.parsed
            models["verify"] = r.model
            out["verified"] = build_review(vr.corrected, cls, sex, first, vr)
            out["verification"] = vr
        except Exception as e:  # noqa: BLE001
            out["verify_error"] = str(e)
        timings["verify"] = int((time.perf_counter() - t0) * 1000)
    return out
