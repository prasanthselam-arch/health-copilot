import mimetypes
import shutil
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlmodel import Session, select

from app.api.deps import document_or_404, llm_error, patient_or_404
from app.db import get_session
from app.fhir.bundle import document_bundle, validate_bundle
from app.models.tables import Document, Patient
from app.pipeline import runner
from app.pipeline.validate import refresh_review
from app.schemas.review import ReviewPayload
from app.services import agent, records, summary
from app.services.safety import LANGUAGES

router = APIRouter(prefix="/api", tags=["documents"])

ALLOWED = {"application/pdf", "image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp"}
MAX_BYTES = 25 * 1024 * 1024


def _doc_out(d: Document, full: bool = False) -> dict[str, Any]:
    exclude = {"fhir_json", "file_path"} | (set() if full else {"raw_extraction", "verified_extraction", "review", "classification"})
    out = d.model_dump(exclude=exclude)
    out["page_urls"] = [f"/api/documents/{d.id}/pages/{i + 1}" for i in range(len(d.page_images or []))]
    out["file_url"] = f"/api/documents/{d.id}/file"
    if not full and d.review:
        out["stats"] = d.review.get("stats")
    return out


@router.post("/patients/{patient_id}/documents")
async def upload(files: list[UploadFile] = File(...), p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    mimes = []
    for f in files:
        mime = f.content_type or mimetypes.guess_type(f.filename or "")[0] or ""
        if mime == "image/jpg":
            mime = "image/jpeg"
        if mime not in ALLOWED:
            raise HTTPException(415, f"{f.filename}: unsupported file type {mime or 'unknown'} (use PDF, JPG, PNG or WEBP)")
        mimes.append(mime)
    created = []
    for f, mime in zip(files, mimes):
        doc = Document(patient_id=p.id, filename=f.filename or "upload", mime_type=mime, file_path="")
        folder = runner.doc_dir(doc.id)
        folder.mkdir(parents=True, exist_ok=True)
        ext = mimetypes.guess_extension(mime) or ""
        path = folder / f"original{'.jpg' if ext in ('.jpe', '.jpeg') else ext}"
        size = 0
        with path.open("wb") as out:
            while chunk := await f.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    out.close()
                    shutil.rmtree(folder, ignore_errors=True)
                    raise HTTPException(413, f"{f.filename}: file larger than 25 MB")
                out.write(chunk)
        doc.file_path = str(path)
        db.add(doc)
        db.commit()
        db.refresh(doc)
        runner.submit(doc.id)
        created.append(_doc_out(doc))
    return created


@router.get("/patients/{patient_id}/documents")
def list_documents(p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    docs = db.exec(select(Document).where(Document.patient_id == p.id).order_by(Document.created_at.desc())).all()  # type: ignore[attr-defined]
    return [_doc_out(d) for d in docs]


@router.get("/documents/{document_id}")
def get_document(d: Document = Depends(document_or_404)):
    return _doc_out(d, full=True)


@router.get("/documents/{document_id}/pages/{n}")
def page_image(n: int, d: Document = Depends(document_or_404)):
    if n < 1 or n > len(d.page_images or []):
        raise HTTPException(404, "Page not found")
    return FileResponse(runner.doc_dir(d.id) / "pages" / d.page_images[n - 1], media_type="image/png")


@router.get("/documents/{document_id}/file")
def original_file(d: Document = Depends(document_or_404)):
    return FileResponse(d.file_path, media_type=d.mime_type, filename=d.filename)


@router.post("/documents/{document_id}/review/refresh")
def refresh(payload: ReviewPayload, d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    p = db.get(Patient, d.patient_id)
    return refresh_review(payload, p.gender if p else None)


@router.post("/documents/{document_id}/confirm")
def confirm(payload: ReviewPayload, d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    if d.status not in ("review", "confirmed"):
        raise HTTPException(409, f"Document is {d.status}, not ready to confirm")
    p = db.get(Patient, d.patient_id)
    payload = refresh_review(payload, p.gender if p else None)
    stats = records.confirm(db, d, payload)
    actions = agent.after_confirm(db, d)
    db.refresh(d)
    return {"document": _doc_out(d), "saved": stats,
            "copilot": [{"id": a.id, "kind": a.kind, "title": a.title} for a in actions]}


@router.post("/documents/{document_id}/reprocess")
def reprocess(d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    if d.source != "upload":
        raise HTTPException(400, "Only uploaded documents can be reprocessed")
    if d.status in ("queued", "processing"):
        raise HTTPException(409, "This document is already being processed")
    records.clear_document_records(db, d.id)
    d.status, d.stage, d.progress, d.review, d.error = "queued", "queued", 0, None, None
    d.classification = d.raw_extraction = d.verified_extraction = None
    db.add(d)
    db.commit()
    runner.submit(d.id)
    return _doc_out(d)


@router.delete("/documents/{document_id}")
def delete(d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    folder = runner.doc_dir(d.id)
    records.delete_document(db, d)
    shutil.rmtree(folder, ignore_errors=True)
    return {"deleted": True}


@router.get("/documents/{document_id}/fhir")
def fhir(d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    if d.status != "confirmed":
        raise HTTPException(409, "Confirm the document first")
    bundle = document_bundle(db, d)
    return JSONResponse({"bundle": bundle, "validation_errors": validate_bundle(bundle)}, media_type="application/json")


@router.get("/documents/{document_id}/summary")
def doc_summary(lang: str = "en", d: Document = Depends(document_or_404), db: Session = Depends(get_session)):
    if d.status != "confirmed":
        raise HTTPException(409, "Confirm the document first")
    if lang not in LANGUAGES:
        raise HTTPException(400, f"Unsupported language {lang}")
    try:
        return summary.document_summary(db, d, lang)
    except Exception as e:  # noqa: BLE001
        raise llm_error(e) from e
