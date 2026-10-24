"""Speech for the chat: reading replies aloud when the browser has no voice for the language, and transcribing
recorded questions when the browser has no speech recognition."""

import hashlib
import io
import logging
import re
import wave
from collections import OrderedDict

from pydantic import BaseModel, Field

from app.config import get_settings
from app.pipeline import llm

log = logging.getLogger(__name__)

MAX_TTS_CHARS = 2500
_cache: OrderedDict[str, bytes] = OrderedDict()


class VoiceUnavailable(RuntimeError):
    pass


def _wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def speak(text: str, lang: str) -> bytes:
    """WAV audio of `text`; the TTS models detect the language from the text itself."""
    text = text.strip()[:MAX_TTS_CHARS]
    if not text:
        raise VoiceUnavailable("Nothing to read")
    key = hashlib.sha256(f"{lang}\0{text}".encode()).hexdigest()
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    s = get_settings()
    if s.llm_provider != "gemini" or not s.gemini_api_key:
        raise VoiceUnavailable("Reading aloud needs the Gemini provider")
    from google.genai import types

    config = types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=s.gemini_tts_voice))),
    )
    errors = []
    for model in [m.strip() for m in s.gemini_tts_models.split(",") if m.strip()]:
        try:
            resp = llm._gemini().models.generate_content(model=model, contents=text, config=config)
            part = resp.candidates[0].content.parts[0].inline_data
            mime = (part.mime_type or "").lower()
            if "wav" in mime:
                audio = part.data
            else:
                rate = re.search(r"rate=(\d+)", mime)
                audio = _wav(part.data, int(rate.group(1)) if rate else 24000)
            _cache[key] = audio
            if len(_cache) > 40:
                _cache.popitem(last=False)
            return audio
        except Exception as e:  # noqa: BLE001 - provider SDK errors
            log.warning("tts %s failed: %s", model, str(e)[:200])
            errors.append(model)
    raise VoiceUnavailable("Reading aloud is unavailable right now")


class Transcript(BaseModel):
    text: str = Field(description="Exactly what was said, in the language and script it was spoken in")
    language: str = Field(description="ISO 639-1 code of the spoken language")


TRANSCRIBE_SYSTEM = """Transcribe the user's spoken question to their health assistant.
Write exactly what was said, in the language spoken, using that language's own script (Telugu in Telugu script,
Hindi in Devanagari, and so on). Keep English words the speaker used (sugar, BP, report, tablet names) in English.
Do not translate, answer or add anything. If nothing intelligible was said, return an empty text."""


def transcribe(data: bytes, mime: str, hint: str | None = None) -> dict[str, str]:
    if not data:
        raise VoiceUnavailable("No audio received")
    s = get_settings()
    if s.llm_provider != "gemini":
        raise VoiceUnavailable("Voice input needs the Gemini provider")
    note = f"The app language is {hint}; the speaker may use a different language." if hint else ""
    r: Transcript = llm.parse("fast", TRANSCRIBE_SYSTEM, [llm.audio(data, mime.split(";")[0]), llm.text(note or "Transcribe.")],
                              Transcript, thinking="minimal", interactive=True).parsed
    return {"text": r.text.strip(), "language": r.language.strip().lower()[:3]}
