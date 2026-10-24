from fastapi import APIRouter, Depends, HTTPException
from typing import Literal

from pydantic import BaseModel
from sqlmodel import Session

from app.api.deps import llm_error, patient_or_404
from app.db import get_session
from app.models.tables import Patient
from app.services import abha_mock, chat, summary
from app.services.safety import LANGUAGES

router = APIRouter(prefix="/api/patients/{patient_id}", tags=["insights"])


@router.get("/summary")
def patient_summary(lang: str = "en", p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    if lang not in LANGUAGES:
        raise HTTPException(400, f"Unsupported language {lang}")
    try:
        return summary.patient_summary(db, p, lang)
    except Exception as e:  # noqa: BLE001
        raise llm_error(e) from e


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatIn(BaseModel):
    message: str
    history: list[ChatTurn] = []
    lang: str = "en"
    voice: bool = False  # asked by voice: a short answer that reads well aloud


@router.post("/chat")
def ask(body: ChatIn, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    if not body.message.strip():
        raise HTTPException(400, "Empty message")
    try:
        return chat.ask(db, p, body.message.strip()[:2000], [h.model_dump() for h in body.history], body.lang if body.lang in LANGUAGES else "en",
                        voice=body.voice)
    except Exception as e:  # noqa: BLE001
        raise llm_error(e) from e


class AbhaInit(BaseModel):
    abha_number: str | None = None
    abha_address: str | None = None


class AbhaConfirm(BaseModel):
    txn_id: str
    otp: str


class AbhaImport(BaseModel):
    hi_types: list[str] = ["Prescription", "DiagnosticReport", "DischargeSummary"]


@router.post("/abha/init")
def abha_init(body: AbhaInit, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    try:
        return abha_mock.init_link(db, p, body.abha_number, body.abha_address)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/abha/confirm")
def abha_confirm(body: AbhaConfirm, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    try:
        return abha_mock.confirm_link(db, p, body.txn_id, body.otp)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/abha/import")
def abha_import(body: AbhaImport, p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    try:
        return abha_mock.import_from_hip(db, p, body.hi_types)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/abha")
def abha_unlink(p: Patient = Depends(patient_or_404), db: Session = Depends(get_session)):
    abha_mock.unlink(db, p)
    return {"linked": False}
