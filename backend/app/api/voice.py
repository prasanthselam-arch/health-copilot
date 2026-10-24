import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

from app.api.deps import current_account, llm_error
from app.services import voice

router = APIRouter(prefix="/api/voice", tags=["voice"], dependencies=[Depends(current_account)])
log = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 8 * 1024 * 1024


class SpeakIn(BaseModel):
    text: str
    lang: str = "en"


@router.post("/speak")
def speak(body: SpeakIn):
    """WAV audio of a chat reply, for browsers without a voice in the reply's language."""
    try:
        audio = voice.speak(body.text, body.lang[:5])
    except voice.VoiceUnavailable as e:
        raise HTTPException(503, str(e)) from e
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/transcribe")
def transcribe(audio: UploadFile = File(...), lang: str = Form("en")):
    """Text of a recorded question, for browsers without built-in speech recognition."""
    data = audio.file.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Recording is too long")
    mime = audio.content_type or "audio/webm"
    if not mime.startswith("audio/"):
        raise HTTPException(415, "Not an audio recording")
    try:
        return voice.transcribe(data, mime, lang[:5])
    except voice.VoiceUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise llm_error(e) from e


class DiagIn(BaseModel):
    events: list[Any] = []
    info: dict[str, Any] = {}


@router.post("/diag", status_code=204)
def diag(body: DiagIn):
    """How a dictation attempt went in the browser (recogniser events, microphone level), for fixing voice issues."""
    log.info("voice diag %s", json.dumps({"info": body.info, "events": body.events[:40]}, default=str)[:2000])
    return Response(status_code=204)
