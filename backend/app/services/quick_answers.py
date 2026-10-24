"""Answers that need no model: "which medicines tonight?" straight from the reminder schedule, in the user's language.

Used when every model is busy or out of quota, so the most common spoken question still gets an instant answer.
"""

from typing import Any

from sqlmodel import Session

from app.models.tables import Patient
from app.services.reminders import doses_for_day, now_ist
from app.services.scheduler import MEAL

# Checked in this order: Assamese "morning" (ৰাতিপুৱা) contains "night" (ৰাতি).
SLOT_WORDS = {
    "morning": ["morning", "subah", "subha", "sakal", "udayam", "kaalai", "kalai", "belige", "savar",
                "सुबह", "सवेरे", "सकाळ", "সকাল", "ৰাতিপুৱা", "ఉదయం", "పొద్దున", "காலை", "ಬೆಳಿಗ್ಗೆ", "ಬೆಳಗ್ಗೆ", "સવાર",
                "صبح", "ସକାଳ", "രാവിലെ", "ਸਵੇਰ"],
    "afternoon": ["afternoon", "noon", "dopahar", "dopehar", "dupar", "madhyanam", "mathiyam",
                  "दोपहर", "दुपार", "দুপুর", "দুপৰীয়া", "మధ్యాహ్న", "மதிய", "ಮಧ್ಯಾಹ್ನ", "બપોર", "دوپہر", "ମଧ୍ୟାହ୍ନ",
                  "ഉച്ച", "ਦੁਪਹਿਰ"],
    "night": ["tonight", "night", "evening", "raat", "ratri", "rathri", "raatri", "iravu",
              "रात", "शाम", "রাত", "ৰাতি", "రాత్రి", "இரவு", "ರಾತ್ರಿ", "રાત", "رات", "ରାତି", "രാത്രി", "ਰਾਤ"],
    "today": ["today", "aaj", "ippudu", "eeroju", "indru", "inru",
              "आज", "আজ", "আজি", "ఈరోజు", "ఈ రోజు", "ఇప్పుడు", "இன்று", "ಇಂದು", "આજે", "آج", "ଆଜି", "ഇന്ന്", "ਅੱਜ"],
}
MEDICINE_WORDS = ["medicine", "medication", "tablet", "pill", "dose", "meds", "dawa", "davai", "goli", "mandu",
                  "marundhu", "marunthu", "mathirai", "maathre", "aushadh", "oushadh", "oshudh", "gulika", "marunnu",
                  "दवा", "दवाई", "दवाइ", "गोली", "औषध", "गोळी", "ওষুধ", "ঔষধ", "দৰব", "বড়ি", "మందు", "మాత్ర",
                  "மருந்து", "மாத்திரை", "ಔಷಧ", "ಮಾತ್ರೆ", "ಗುಳಿಗೆ", "દવા", "ગોળી", "دوا", "گولی", "ଔଷଧ", "ବଟିକା",
                  "മരുന്ന", "ഗുളിക", "ਦਵਾਈ", "ਦਵਾ", "ਗੋਲੀ"]

TEXT = {
    "en": ("Medicines for this morning", "Medicines for this afternoon", "Medicines for tonight", "Medicines for today",
           "No medicines are scheduled for this time.", "already taken"),
    "hi": ("आज सुबह की दवाइयाँ", "आज दोपहर की दवाइयाँ", "आज रात की दवाइयाँ", "आज की दवाइयाँ",
           "इस समय के लिए कोई दवा तय नहीं है।", "ले ली गई"),
    "bn": ("আজ সকালের ওষুধ", "আজ দুপুরের ওষুধ", "আজ রাতের ওষুধ", "আজকের ওষুধ",
           "এই সময়ের জন্য কোনো ওষুধ নির্ধারিত নেই।", "খাওয়া হয়েছে"),
    "mr": ("आज सकाळची औषधे", "आज दुपारची औषधे", "आज रात्रीची औषधे", "आजची औषधे",
           "या वेळेसाठी कोणतेही औषध ठरलेले नाही.", "घेतले"),
    "te": ("ఈ ఉదయం మందులు", "ఈ మధ్యాహ్నం మందులు", "ఈ రాత్రి మందులు", "ఈరోజు మందులు",
           "ఈ సమయానికి మందులు ఏవీ లేవు.", "వేసుకున్నారు"),
    "ta": ("இன்று காலை மருந்துகள்", "இன்று மதியம் மருந்துகள்", "இன்று இரவு மருந்துகள்", "இன்றைய மருந்துகள்",
           "இந்த நேரத்திற்கு மருந்துகள் எதுவும் இல்லை.", "எடுத்துவிட்டீர்கள்"),
    "gu": ("આજે સવારની દવાઓ", "આજે બપોરની દવાઓ", "આજે રાતની દવાઓ", "આજની દવાઓ",
           "આ સમય માટે કોઈ દવા નક્કી નથી.", "લીધી"),
    "ur": ("آج صبح کی دوائیں", "آج دوپہر کی دوائیں", "آج رات کی دوائیں", "آج کی دوائیں",
           "اس وقت کے لیے کوئی دوا مقرر نہیں ہے۔", "لے لی"),
    "kn": ("ಇಂದು ಬೆಳಿಗ್ಗೆಯ ಔಷಧಿಗಳು", "ಇಂದು ಮಧ್ಯಾಹ್ನದ ಔಷಧಿಗಳು", "ಇಂದು ರಾತ್ರಿಯ ಔಷಧಿಗಳು", "ಇಂದಿನ ಔಷಧಿಗಳು",
           "ಈ ಸಮಯಕ್ಕೆ ಯಾವುದೇ ಔಷಧಿ ನಿಗದಿಯಾಗಿಲ್ಲ.", "ತೆಗೆದುಕೊಂಡಿದ್ದೀರಿ"),
    "or": ("ଆଜି ସକାଳର ଔଷଧ", "ଆଜି ମଧ୍ୟାହ୍ନର ଔଷଧ", "ଆଜି ରାତିର ଔଷଧ", "ଆଜିର ଔଷଧ",
           "ଏହି ସମୟ ପାଇଁ କୌଣସି ଔଷଧ ସ୍ଥିର ହୋଇନାହିଁ।", "ଖାଇସାରିଛନ୍ତି"),
    "ml": ("ഇന്ന് രാവിലത്തെ മരുന്നുകൾ", "ഇന്ന് ഉച്ചയ്ക്കുള്ള മരുന്നുകൾ", "ഇന്ന് രാത്രിയിലെ മരുന്നുകൾ", "ഇന്നത്തെ മരുന്നുകൾ",
           "ഈ സമയത്തേക്ക് മരുന്നുകളൊന്നും നിശ്ചയിച്ചിട്ടില്ല.", "കഴിച്ചു"),
    "pa": ("ਅੱਜ ਸਵੇਰ ਦੀਆਂ ਦਵਾਈਆਂ", "ਅੱਜ ਦੁਪਹਿਰ ਦੀਆਂ ਦਵਾਈਆਂ", "ਅੱਜ ਰਾਤ ਦੀਆਂ ਦਵਾਈਆਂ", "ਅੱਜ ਦੀਆਂ ਦਵਾਈਆਂ",
           "ਇਸ ਸਮੇਂ ਲਈ ਕੋਈ ਦਵਾਈ ਤੈਅ ਨਹੀਂ ਹੈ।", "ਲੈ ਲਈ"),
    "as": ("আজি ৰাতিপুৱাৰ ঔষধ", "আজি দুপৰীয়াৰ ঔষধ", "আজি ৰাতিৰ ঔষধ", "আজিৰ ঔষধ",
           "এই সময়ৰ বাবে কোনো ঔষধ নিৰ্ধাৰিত নাই।", "খোৱা হ'ল"),
}
SLOTS = ("morning", "afternoon", "night", "today")


def schedule_question(message: str) -> str | None:
    """'morning' | 'afternoon' | 'night' | 'today' when the message asks which medicines to take then, else None."""
    m = message.lower()
    if not any(w in m for w in MEDICINE_WORDS):
        return None
    for slot in SLOTS:
        if any(w in m for w in SLOT_WORDS[slot]):
            return slot
    return None


def schedule_answer(db: Session, patient: Patient, slot: str, lang: str) -> dict[str, Any]:
    texts = TEXT.get(lang, TEXT["en"])
    now = now_ist()
    doses = [d for d in doses_for_day(db, [patient], now.date(), now) if slot == "today" or d["slot"] == slot]
    doses.sort(key=lambda d: d["time"])
    if not doses:
        return {"answer": texts[4], "medication_ids": []}
    lines = []
    for d in doses:
        meal = MEAL.get(lang, {}).get(d["detail"], d["detail"]) if d.get("detail") else ""
        parts = [p for p in (d["title"], d.get("amount"), meal) if p]
        done = f" ({texts[5]})" if d["status"] == "taken" else ""
        lines.append(f"- **{d['time']}** · {', '.join(parts)}{done}")
    return {"answer": f"{texts[SLOTS.index(slot)]}:\n\n" + "\n".join(lines),
            "medication_ids": list(dict.fromkeys(d["medication_id"] for d in doses if d.get("medication_id")))}
