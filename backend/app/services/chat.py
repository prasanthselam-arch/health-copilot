"""'Ask my records': grounded Q&A over the patient's own structured records."""

import json
import re
from datetime import date
from typing import Any

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.models.tables import Condition, Document, MedicationRequest, Observation, Patient
from app.pipeline import llm
from app.services import facts as F
from app.services.safety import EMERGENCY_NOTICE, LANGUAGES, check_text, is_emergency, redact


class ChatAnswer(BaseModel):
    reply_language: str = Field(default="", description="ISO 639-1 code of the language you replied in (en, hi, te, ta, kn, ml, mr, bn, ...)")
    understood_question: str = Field(default="", description="The user's question restated in plain English, one short sentence")
    answer: str = Field(description="Answer as short Markdown (max ~150 words of prose), in the language of the user's question")
    cited_record_ids: list[str] = Field(description="IDs of records used for the answer")
    answered_from_records: bool = Field(description="False if the records do not contain the answer")
    suggest_doctor: bool = Field(description="True if the question needs a clinician's judgement")
    follow_up_questions: list[str] = Field(
        default_factory=list, description="2-3 short follow-up questions the user might ask next, in the reply language")
    emergency_symptoms: bool = Field(default=False, description="True if the user describes emergency symptoms, in any language")


CHAT_SYSTEM = """You are a careful personal health copilot. You answer questions about the user's OWN health records.
RECORDS (JSON) are provided; every record has an `id`.
Rules:
- Answer from the records first and cite the ids you used: the id of every individual result, medicine and condition
  you mention, not only the document. Quote values and dates exactly as in the records.
- If the records do not contain the answer, say so plainly. You may add brief, well-established general health information, clearly labelled as general information.
- Never diagnose. Never tell the user to start, stop, skip or change a medicine or dose; for such questions explain what the record says and advise asking their doctor.
- For worrying symptoms, advise contacting a doctor; for emergency symptoms, advise calling 112.
- `reminders` are the user's daily dose times (India time; morning before 12:00, night after 17:00). For questions like
  "which medicines tonight?" list them with their times and cite each `medication_id`. `now` is the current time.
- `appointments`, `tests_due` and `care_alerts` are computed by the app from these records. Use them for "when is my
  next visit / test" and "is anything worrying" questions, citing the `result_ids` they list; present alerts as things
  to discuss with the doctor, never as a diagnosis.
- Be warm, calm and brief. Keep drug names, numbers and units unchanged.
Language:
- Work out the language of the USER QUESTION and reply in that language, written in its own script. Users often type
  Indian languages in English letters, mixed with English words: "na health ela vundhi ippudu" is Telugu (reply in
  Telugu script, e.g. "మీ ఆరోగ్యం..."), "mera sugar kitna hai" is Hindi (Devanagari), "en BP evlo irukku" is Tamil,
  "nanna sugar eshtu ide" is Kannada, "ente pressure engane und" is Malayalam. Medical words like sugar, BP, report or
  tablet inside such a sentence do not make it English. This works for any language, not only Indian ones.
- If the question is in English, reply in English. If it is too short to tell (e.g. "ok", "HbA1c?"), reply in the
  language of the conversation so far, or else in {language}.
- Write follow_up_questions in the same language and script as the answer; set reply_language to its ISO 639-1 code.
- emergency_symptoms: true when the user describes chest pain, trouble breathing, fainting, stroke signs, heavy
  bleeding, seizures or thoughts of self-harm, in any language or spelling.
Formatting (Markdown):
- Below your answer the app shows every cited result (value, range, flag, trend) and medicine (dose schedule) as cards,
  so do not list every value again. Say what stands out and what to do next, in 1-3 short paragraphs or a few bullets.
- Use **bold** for the few values or medicines that matter most.
- Use a Markdown table only when the user asks for one or to compare a value across dates. Put the header, the
  separator row and every data row on separate lines.
- No headings, no code blocks, no links.
- follow_up_questions: 2-3 natural next questions about these records, phrased as the user would ask them.
"""

VOICE_RULES = """
SPOKEN QUESTION: the user asked by voice and the answer will be read aloud to them, often an elderly person.
- Answer in 1-3 short, simple spoken sentences (under 60 words). Answer the question directly in the first sentence.
- Plain speech only: no Markdown, bullets, tables or bold. Say times the way people speak them in that language
  (for example "9 at night" rather than "21:00"). Say each medicine with its dose and when to take it.
- Speech recognition may have misheard medicine or test names; match them to the closest name in the records.
"""


def _records(db: Session, patient: Patient) -> dict[str, Any]:
    docs = db.exec(select(Document).where(Document.patient_id == patient.id, Document.status == "confirmed")).all()
    obs = db.exec(select(Observation).where(Observation.patient_id == patient.id)).all()
    meds = db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient.id)).all()
    conds = db.exec(select(Condition).where(Condition.patient_id == patient.id)).all()
    obs = sorted(obs, key=lambda o: o.effective_date.isoformat() if o.effective_date else "", reverse=True)[:200]
    return {
        "patient": {"gender": patient.gender, "abha_linked": bool(patient.abha_number)},
        "documents": [{"id": d.id, "type": d.doc_type, "title": d.title, "date": d.document_date.isoformat() if d.document_date else None,
                       "facility": d.facility, "doctor": d.author} for d in docs],
        "conditions": [F.cond_fact(c) for c in conds],
        "medications": [F.med_fact(m) for m in meds],
        "results": [F.obs_fact(o) for o in obs],
        **_care_records(db, patient),
    }


def _care_records(db: Session, patient: Patient) -> dict[str, Any]:
    """Reminder times, upcoming visits and computed alerts, so 'tonight's medicines' or 'when is my test due' are grounded."""
    from app.models.tables import Appointment, Reminder
    from app.services import care
    from app.services.reminders import now_ist

    now = now_ist()
    rems = db.exec(select(Reminder).where(Reminder.patient_id == patient.id, Reminder.status == "active")).all()
    appts = db.exec(select(Appointment).where(Appointment.patient_id == patient.id, Appointment.status == "upcoming")).all()
    prof = care.build_profile(db, patient)
    return {
        "now": now.strftime("%Y-%m-%d %H:%M (%A), India time"),
        "reminders": [{"medication_id": r.medication_id, "medicine": r.title, "when": r.detail,
                       "times": [f"{s['time']} {s.get('amount') or ''}".strip() for s in r.slots],
                       "until": r.end_date.isoformat() if r.end_date else None} for r in rems],
        "appointments": [{"id": a.id, "kind": a.kind, "title": a.title, "due": a.due_date.isoformat(),
                          "overdue": a.due_date < now.date()} for a in appts],
        "care_alerts": [{"title": i["title"], "detail": i["body"], "level": i["level"], "result_ids": [e["id"] for e in i["evidence"]]}
                        for i in care.insights(prof)[:8]],
        "tests_due": [{"test": i["title"], "status": i["status"], "due": i["due_date"]}
                      for i in care.preventive(prof, list(appts), now.date()) if i["status"] in ("overdue", "due_soon", "not_done")][:6],
    }


def _label_index(db: Session, patient: Patient) -> dict[str, dict[str, Any]]:
    idx: dict[str, dict[str, Any]] = {}
    for d in db.exec(select(Document).where(Document.patient_id == patient.id)).all():
        idx[d.id] = {"kind": "document", "label": d.title or d.doc_type, "date": d.document_date, "document_id": d.id}
    for o in db.exec(select(Observation).where(Observation.patient_id == patient.id)).all():
        idx[o.id] = {"kind": "result", "label": f"{o.name}: {o.value_num if o.value_num is not None else o.value_text} {o.unit or ''}".strip(),
                     "date": o.effective_date, "document_id": o.document_id}
    for m in db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient.id)).all():
        idx[m.id] = {"kind": "medication", "label": f"{m.name} {m.strength or ''}".strip(), "date": m.authored_on, "document_id": m.document_id}
    for c in db.exec(select(Condition).where(Condition.patient_id == patient.id)).all():
        idx[c.id] = {"kind": "condition", "label": c.name, "date": c.recorded_date, "document_id": c.document_id}
    from app.models.tables import Appointment

    for a in db.exec(select(Appointment).where(Appointment.patient_id == patient.id)).all():
        idx[a.id] = {"kind": "appointment", "label": a.title, "date": a.due_date, "document_id": a.document_id}
    return idx


def ask(db: Session, patient: Patient, message: str, history: list[dict[str, str]], lang: str = "en",
        voice: bool = False) -> dict[str, Any]:
    records = _records(db, patient)
    convo = "\n".join(f"{h['role'].upper()}: {h['content']}" for h in history[-6:])
    data = json.dumps(records, ensure_ascii=False, default=str, separators=(",", ":"))
    prompt = f"RECORDS:\n{data}\n\nCONVERSATION SO FAR:\n{convo}\n\nUSER QUESTION: {message}"
    system = CHAT_SYSTEM.format(language=LANGUAGES.get(lang, "English")) + (VOICE_RULES if voice else "")
    try:
        r: ChatAnswer = llm.parse("fast", system, prompt, ChatAnswer, thinking="minimal" if voice else None,
                                 interactive=True).parsed
    except Exception:
        fallback = _quick_answer(db, patient, message, lang)
        if fallback is None:
            raise
        return fallback
    text = _RAW_IDS.sub("", r.answer).strip()
    safety = check_text(text)
    answer = text if safety.passed else redact(text)
    reply_lang = reply_language(answer, r.reply_language)
    idx = _label_index(db, patient)
    citations = []
    for rid in dict.fromkeys([*r.cited_record_ids, *_mentioned(db, patient, answer, set(r.cited_record_ids))]):
        if rid in idx:
            c = idx[rid]
            citations.append({"id": rid, **c, "date": c["date"].isoformat() if c["date"] else None})
    cited = [c["id"] for c in citations]
    return {
        "answer": answer,
        "citations": citations,
        "results": _cited_results(db, patient, [i for i in cited if idx[i]["kind"] == "result"]),
        "medications": _latest(_cited(db, MedicationRequest, [i for i in cited if idx[i]["kind"] == "medication"]),
                               lambda m: ((m["generic"] or m["name"]).lower(), (m["strength"] or "").replace(" ", "").lower()), "authored_on"),
        "follow_ups": [q.strip() for q in r.follow_up_questions if q.strip()][:3],
        "reply_language": reply_lang,
        "understood_question": r.understood_question.strip() or None,
        "answered_from_records": r.answered_from_records,
        "suggest_doctor": r.suggest_doctor,
        "emergency_notice": EMERGENCY_NOTICE.get(reply_lang, EMERGENCY_NOTICE.get(lang, EMERGENCY_NOTICE["en"]))
        if r.emergency_symptoms or is_emergency(message) else None,
        "safety": {"passed": safety.passed, "violations": safety.violations},
    }


# Record ids the model sometimes writes into the prose ("[3a3ddba0-…, …]"); the app shows citations as cards instead.
_RAW_IDS = re.compile(r"\s*[\[(](?:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*,?)+[\])]", re.I)


def _quick_answer(db: Session, patient: Patient, message: str, lang: str) -> dict[str, Any] | None:
    """When no model is available: answer "which medicines tonight/today?" from the reminder schedule."""
    from app.services import quick_answers as Q

    slot = Q.schedule_question(message)
    if not slot:
        return None
    out_lang = reply_language(message, patient.preferred_language or lang)
    if out_lang == "en" and not any(w in message.lower() for w in ("medicine", "medication", "tablet", "pill", "dose", "meds")):
        out_lang = patient.preferred_language or lang  # an Indian language typed in English letters
    if out_lang not in Q.TEXT:
        out_lang = "en"
    a = Q.schedule_answer(db, patient, slot, out_lang)
    idx = _label_index(db, patient)
    citations = [{"id": i, **idx[i], "date": idx[i]["date"].isoformat() if idx[i]["date"] else None}
                 for i in a["medication_ids"] if i in idx]
    return {
        "answer": a["answer"],
        "citations": citations,
        "results": [],
        "medications": _latest(_cited(db, MedicationRequest, [c["id"] for c in citations]),
                               lambda m: ((m["generic"] or m["name"]).lower(), (m["strength"] or "").replace(" ", "").lower()), "authored_on"),
        "follow_ups": [],
        "reply_language": out_lang,
        "understood_question": None,
        "answered_from_records": True,
        "suggest_doctor": False,
        "emergency_notice": EMERGENCY_NOTICE.get(out_lang, EMERGENCY_NOTICE["en"]) if is_emergency(message) else None,
        "safety": {"passed": True, "violations": []},
        "quick": True,
    }


# Script of each Unicode block -> the language it most likely is when the model's own label is missing or wrong.
_SCRIPTS = [((0x0900, 0x097F), "deva", "hi"), ((0x0980, 0x09FF), "beng", "bn"), ((0x0A00, 0x0A7F), "guru", "pa"),
            ((0x0A80, 0x0AFF), "gujr", "gu"), ((0x0B00, 0x0B7F), "orya", "or"), ((0x0B80, 0x0BFF), "taml", "ta"),
            ((0x0C00, 0x0C7F), "telu", "te"), ((0x0C80, 0x0CFF), "knda", "kn"), ((0x0D00, 0x0D7F), "mlym", "ml"),
            ((0x0600, 0x06FF), "arab", "ur"), ((0x0D80, 0x0DFF), "sinh", "si")]
_LANG_SCRIPT = {"hi": "deva", "mr": "deva", "ne": "deva", "sa": "deva", "bn": "beng", "as": "beng", "pa": "guru",
                "gu": "gujr", "or": "orya", "ta": "taml", "te": "telu", "kn": "knda", "ml": "mlym", "ur": "arab",
                "ar": "arab", "fa": "arab", "si": "sinh"}
_NAMES = {"english": "en", "hindi": "hi", "telugu": "te", "tamil": "ta", "kannada": "kn", "malayalam": "ml",
          "marathi": "mr", "bengali": "bn", "bangla": "bn", "gujarati": "gu", "punjabi": "pa", "odia": "or", "oriya": "or",
          "urdu": "ur", "assamese": "as", "arabic": "ar", "nepali": "ne"}


def _script(text: str) -> str | None:
    counts: dict[str, int] = {}
    for ch in text:
        cp = ord(ch)
        for (lo, hi), script, _ in _SCRIPTS:
            if lo <= cp <= hi:
                counts[script] = counts.get(script, 0) + 1
    letters = sum(ch.isalpha() for ch in text) or 1
    best = max(counts, key=lambda k: counts[k], default=None)
    return best if best and counts[best] / letters > 0.3 else None


def reply_language(answer: str, claimed: str) -> str:
    """ISO code of the language the answer is written in: the model's label when it fits the script, otherwise the
    script's usual language, so the UI badge and the text-to-speech voice match the text."""
    c = claimed.strip().lower().replace("_", "-")
    c = _NAMES.get(c, c.split("-")[0])
    if not re.fullmatch(r"[a-z]{2,3}", c):
        c = ""
    script = _script(answer)
    if script:
        return c if _LANG_SCRIPT.get(c) == script else next(code for _, s, code in _SCRIPTS if s == script)
    return "en" if not c or c in _LANG_SCRIPT else c


def _mentioned(db: Session, patient: Patient, answer: str, cited: set[str]) -> list[str]:
    """Ids of the results and medicines the answer talks about, found in code because the model often cites only the
    document: the latest value of each test named in the answer (or whose value appears and whose report is cited),
    and the latest prescription of each medicine named in the answer."""
    text = answer.lower()
    numbers = set(re.findall(r"\d+(?:\.\d+)?", answer))
    found: list[tuple[int, str]] = []

    latest: dict[str, Observation] = {}
    for o in db.exec(select(Observation).where(Observation.patient_id == patient.id)).all():
        k = o.loinc or o.name.lower()
        if k not in latest or (o.effective_date or date.min) >= (latest[k].effective_date or date.min):
            latest[k] = o
    for o in latest.values():
        pos = text.find(o.name.lower())
        value = {f"{o.value_num:g}", str(o.value_num)} if o.value_num is not None else set()
        if pos < 0 and o.document_id in cited and value & numbers:
            pos = len(text)
        if pos >= 0:
            found.append((pos, o.id))

    meds: dict[str, MedicationRequest] = {}
    for m in db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == patient.id)).all():
        k = m.name.lower()
        if k not in meds or (m.authored_on or date.min) >= (meds[k].authored_on or date.min):
            meds[k] = m
    for k, m in meds.items():
        pos = min((i for i in (text.find(k), text.find((m.generic or "\0").lower())) if i >= 0), default=-1)
        if pos >= 0:
            found.append((pos, m.id))
    return [i for _, i in sorted(found)]


def _cited(db: Session, model: Any, ids: list[str]) -> list[dict[str, Any]]:
    rows = {r.id: r for r in db.exec(select(model).where(model.id.in_(ids))).all()} if ids else {}
    return [rows[i].model_dump(mode="json") for i in ids if i in rows]


def _latest(rows: list[dict[str, Any]], key: Any, date_field: str) -> list[dict[str, Any]]:
    """One row per key (the same medicine from two copies of a prescription, the same test on two dates), keeping the
    most recent and the original order."""
    best: dict[Any, dict[str, Any]] = {}
    for r in rows:
        k = key(r)
        if k not in best or (r[date_field] or "") > (best[k][date_field] or ""):
            best[k] = r
    keep = {id(r) for r in best.values()}
    return [r for r in rows if id(r) in keep]


def _cited_results(db: Session, patient: Patient, ids: list[str]) -> list[dict[str, Any]]:
    """Cited results straight from the database, each with its earlier values of the same test for a trend line."""
    results = _latest(_cited(db, Observation, ids), lambda o: o["loinc"] or o["name"].lower(), "effective_date")
    if not results:
        return []
    history: dict[str, list[Observation]] = {}
    for o in db.exec(select(Observation).where(Observation.patient_id == patient.id)).all():
        if o.value_num is not None and o.effective_date:
            history.setdefault(o.loinc or o.name.lower(), []).append(o)
    for r in results:
        points = sorted(history.get(r["loinc"] or r["name"].lower(), []), key=lambda o: o.effective_date)[-12:]
        r["trend"] = [{"date": o.effective_date.isoformat(), "value": o.value_num, "flag": o.interpretation} for o in points] \
            if len(points) > 1 else []
    return results
