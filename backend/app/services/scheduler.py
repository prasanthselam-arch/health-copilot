"""Background loop: dose and appointment notifications at the right time, plus the daily copilot check.

Runs inside the web process (the AWS server is always on). Each notification is recorded in Notification under a
unique key, so a restart never repeats one.
"""

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, col, select

from app.db import engine
from app.models.tables import Account, Appointment, Notification, Patient
from app.services import agent, push, reminders
from app.services.reminders import IST, now_ist

log = logging.getLogger(__name__)
TICK_SECONDS = 30
NOTIFY_WINDOW = timedelta(minutes=45)  # a dose is announced once, up to this long after its time
DAILY_AT = (9, 0)

TEXT = {
    "en": {"dose": "Time for {title}", "dose_body": "{who}{amount}{detail}", "taken": "Taken", "snooze": "Snooze 15 min",
           "appt_tomorrow": "Tomorrow: {title}", "appt_today": "Today: {title}", "for": "For {name}: "},
    "hi": {"dose": "{title} लेने का समय", "dose_body": "{who}{amount}{detail}", "taken": "ले ली", "snooze": "15 मिनट बाद",
           "appt_tomorrow": "कल: {title}", "appt_today": "आज: {title}", "for": "{name} के लिए: "},
    "te": {"dose": "{title} వేసుకునే సమయం", "dose_body": "{who}{amount}{detail}", "taken": "వేసుకున్నాను", "snooze": "15 ని. తర్వాత",
           "appt_tomorrow": "రేపు: {title}", "appt_today": "ఈరోజు: {title}", "for": "{name} కోసం: "},
    "ta": {"dose": "{title} எடுக்கும் நேரம்", "dose_body": "{who}{amount}{detail}", "taken": "எடுத்தேன்", "snooze": "15 நிமி. பிறகு",
           "appt_tomorrow": "நாளை: {title}", "appt_today": "இன்று: {title}", "for": "{name} க்காக: "},
    "kn": {"dose": "{title} ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯ", "dose_body": "{who}{amount}{detail}", "taken": "ತೆಗೆದುಕೊಂಡೆ", "snooze": "15 ನಿ. ನಂತರ",
           "appt_tomorrow": "ನಾಳೆ: {title}", "appt_today": "ಇಂದು: {title}", "for": "{name} ಗಾಗಿ: "},
    "bn": {"dose": "{title} খাওয়ার সময় হয়েছে", "dose_body": "{who}{amount}{detail}", "taken": "খেয়েছি", "snooze": "15 মিনিট পরে মনে করান", "appt_tomorrow": "আগামীকাল: {title}", "appt_today": "আজ: {title}", "for": "{name}-এর জন্য: "},
    "mr": {"dose": "{title} घेण्याची वेळ झाली", "dose_body": "{who}{amount}{detail}", "taken": "घेतले", "snooze": "15 मिनिटांनी आठवण द्या", "appt_tomorrow": "उद्या: {title}", "appt_today": "आज: {title}", "for": "{name} साठी: "},
    "gu": {"dose": "{title} લેવાનો સમય", "dose_body": "{who}{amount}{detail}", "taken": "લીધી", "snooze": "15 મિનિટ પછી યાદ કરાવો", "appt_tomorrow": "આવતીકાલે: {title}", "appt_today": "આજે: {title}", "for": "{name} માટે: "},
    "ml": {"dose": "{title} കഴിക്കാനുള്ള സമയം", "dose_body": "{who}{amount}{detail}", "taken": "കഴിച്ചു", "snooze": "15 മിനിറ്റ് കഴിഞ്ഞ് ഓർമ്മിപ്പിക്കൂ", "appt_tomorrow": "നാളെ: {title}", "appt_today": "ഇന്ന്: {title}", "for": "{name}-ന്: "},
    "or": {"dose": "{title} ଖାଇବା ସମୟ", "dose_body": "{who}{amount}{detail}", "taken": "ଖାଇଲି", "snooze": "15 ମିନିଟ ପରେ ମନେ ପକାନ୍ତୁ", "appt_tomorrow": "କାଲି: {title}", "appt_today": "ଆଜି: {title}", "for": "{name}ଙ୍କ ପାଇଁ: "},
    "ur": {"dose": "{title} لینے کا وقت", "dose_body": "{who}{amount}{detail}", "taken": "لے لی", "snooze": "15 منٹ بعد یاد دلائیں", "appt_tomorrow": "کل: {title}", "appt_today": "آج: {title}", "for": "{name} کے لیے: "},
    "pa": {"dose": "{title} ਦਾ ਸਮਾਂ", "dose_body": "{who}{amount}{detail}", "taken": "ਲੈ ਲਈ", "snooze": "15 ਮਿੰਟ ਬਾਅਦ ਯਾਦ ਕਰਾਓ", "appt_tomorrow": "ਕੱਲ੍ਹ: {title}", "appt_today": "ਅੱਜ: {title}", "for": "{name} ਲਈ: "},
    "as": {"dose": "{title} খোৱাৰ সময় হ'ল", "dose_body": "{who}{amount}{detail}", "taken": "খালোঁ", "snooze": "15 মিনিট পিছত", "appt_tomorrow": "কাইলৈ: {title}", "appt_today": "আজি: {title}", "for": "{name}ৰ বাবে: "},
}
MEAL = {
    "hi": {"after food": "खाने के बाद", "before food": "खाने से पहले", "with food": "खाने के साथ", "on an empty stomach": "खाली पेट", "at bedtime": "सोते समय"},
    "te": {"after food": "భోజనం తర్వాత", "before food": "భోజనానికి ముందు", "with food": "భోజనంతో", "on an empty stomach": "పరగడుపున", "at bedtime": "నిద్రకు ముందు"},
    "ta": {"after food": "உணவுக்குப் பின்", "before food": "உணவுக்கு முன்", "with food": "உணவுடன்", "on an empty stomach": "வெறும் வயிற்றில்", "at bedtime": "தூங்கும் முன்"},
    "kn": {"after food": "ಊಟದ ನಂತರ", "before food": "ಊಟದ ಮೊದಲು", "with food": "ಊಟದೊಂದಿಗೆ", "on an empty stomach": "ಖಾಲಿ ಹೊಟ್ಟೆಯಲ್ಲಿ", "at bedtime": "ಮಲಗುವ ಮುನ್ನ"},
    "bn": {"after food": "খাওয়ার পরে", "before food": "খাওয়ার আগে", "with food": "খাওয়ার সঙ্গে", "on an empty stomach": "খালি পেটে", "at bedtime": "শোওয়ার সময়"},
    "mr": {"after food": "जेवणानंतर", "before food": "जेवणाआधी", "with food": "जेवणासोबत", "on an empty stomach": "उपाशीपोटी", "at bedtime": "झोपताना"},
    "gu": {"after food": "જમ્યા પછી", "before food": "જમ્યા પહેલાં", "with food": "જમતી વખતે", "on an empty stomach": "ખાલી પેટે", "at bedtime": "સૂતી વખતે"},
    "ml": {"after food": "ഭക്ഷണത്തിന് ശേഷം", "before food": "ഭക്ഷണത്തിന് മുമ്പ്", "with food": "ഭക്ഷണത്തോടൊപ്പം", "on an empty stomach": "വെറുംവയറ്റിൽ", "at bedtime": "ഉറങ്ങുന്നതിന് മുമ്പ്"},
    "or": {"after food": "ଖାଇବା ପରେ", "before food": "ଖାଇବା ଆଗରୁ", "with food": "ଖାଇବା ସହିତ", "on an empty stomach": "ଖାଲି ପେଟରେ", "at bedtime": "ଶୋଇବା ବେଳେ"},
    "ur": {"after food": "کھانے کے بعد", "before food": "کھانے سے پہلے", "with food": "کھانے کے ساتھ", "on an empty stomach": "خالی پیٹ", "at bedtime": "سوتے وقت"},
    "pa": {"after food": "ਖਾਣੇ ਤੋਂ ਬਾਅਦ", "before food": "ਖਾਣੇ ਤੋਂ ਪਹਿਲਾਂ", "with food": "ਖਾਣੇ ਦੇ ਨਾਲ", "on an empty stomach": "ਖਾਲੀ ਪੇਟ", "at bedtime": "ਸੌਣ ਵੇਲੇ"},
    "as": {"after food": "খোৱাৰ পিছত", "before food": "খোৱাৰ আগত", "with food": "খোৱাৰ লগত", "on an empty stomach": "খালী পেটত", "at bedtime": "শোৱাৰ সময়ত"},
}

_stop = threading.Event()
_thread: threading.Thread | None = None


def _sent(db: Session, account_id: str, key: str) -> bool:
    return db.exec(select(Notification).where(Notification.account_id == account_id, Notification.key == key)).first() is not None


def dose_message(d: dict, lang: str, self_profile: bool) -> dict:
    t = TEXT.get(lang, TEXT["en"])
    detail = d.get("detail") or ""
    detail = MEAL.get(lang, {}).get(detail, detail)
    who = "" if self_profile else t["for"].format(name=d["patient_name"].split(" ")[0])
    body = t["dose_body"].format(who=who, amount=d["amount"], detail=f" · {detail}" if detail else "")
    return {"title": t["dose"].format(title=d["title"]), "body": body.strip(" ·"),
            "tag": f"dose:{d['reminder_id']}:{d['day']}:{d['time']}", "url": "/reminders",
            "dose": {"reminder_id": d["reminder_id"], "day": d["day"], "time": d["time"]},
            "actions": [{"action": "taken", "title": t["taken"]}, {"action": "snooze", "title": t["snooze"]}]}


def due_now(db: Session, acc: Account, now: datetime) -> list[dict]:
    """Doses of this account that should be announced right now (due within the window, or a snooze ran out)."""
    patients = list(db.exec(select(Patient).where(Patient.owner_id == acc.id)).all())
    out = []
    for d in reminders.doses_for_day(db, patients, now.date(), now):
        due_at = reminders._at(now.date(), d["time"])
        if d["status"] != "due":
            continue
        if not d["was_snoozed"] and now - due_at > NOTIFY_WINDOW:
            continue
        out.append(d)
    return out


def tick(now: datetime | None = None) -> dict[str, int]:
    now = (now or now_ist()).astimezone(IST)
    stats = {"doses": 0, "appointments": 0}
    with Session(engine) as db:
        accounts = db.exec(select(Account)).all()
        for acc in accounts:
            if not acc.notify_medicines:
                continue
            patients = {p.id: p for p in db.exec(select(Patient).where(Patient.owner_id == acc.id)).all()}
            if not patients:
                continue
            for d in due_now(db, acc, now):
                from app.models.tables import DoseLog

                lg = db.exec(select(DoseLog).where(DoseLog.reminder_id == d["reminder_id"], DoseLog.day == now.date(),
                                                   DoseLog.time == d["time"])).first()
                key = f"dose:{d['reminder_id']}:{d['day']}:{d['time']}" + (f":{lg.snooze_until.isoformat()}" if lg and lg.snooze_until else "")
                if _sent(db, acc.id, key):
                    continue
                p = patients[d["patient_id"]]
                push.send(db, acc.id, dose_message(d, p.preferred_language or "en", p.relationship == "self"))
                db.add(Notification(account_id=acc.id, key=key))
                db.commit()
                stats["doses"] += 1
            for a in reminders.upcoming_appointments(db, list(patients)):
                p = patients[a.patient_id]
                t = TEXT.get(p.preferred_language or "en", TEXT["en"])
                for when, msg, at in (("tomorrow", t["appt_tomorrow"], (a.due_date - timedelta(days=1), 18)),
                                      ("today", t["appt_today"], (a.due_date, 8))):
                    fire = datetime(at[0].year, at[0].month, at[0].day, at[1], 0, tzinfo=IST)
                    if not (fire <= now < fire + timedelta(hours=3)):
                        continue
                    key = f"appt:{a.id}:{when}"
                    if _sent(db, acc.id, key):
                        continue
                    who = "" if p.relationship == "self" else t["for"].format(name=p.name.split(" ")[0])
                    push.send(db, acc.id, {"title": msg.format(title=a.title), "body": who + (a.time or "") + (f" · {a.facility}" if a.facility else ""),
                                           "tag": key, "url": "/reminders"})
                    db.add(Notification(account_id=acc.id, key=key))
                    db.commit()
                    stats["appointments"] += 1
        _daily(db, now)
    return stats


def _daily(db: Session, now: datetime) -> None:
    if (now.hour, now.minute) < DAILY_AT:
        return
    key = f"daily:{now.date().isoformat()}"
    if _sent(db, "system", key):
        return
    from app.services import notifications

    db.add(Notification(account_id="system", key=key))
    db.commit()
    for p in db.exec(select(Patient).where(col(Patient.owner_id).is_not(None))).all():
        try:
            agent.sweep(db, p)
        except Exception:  # noqa: BLE001
            log.exception("Copilot sweep failed for %s", p.id)
            db.rollback()
    try:
        notifications.run_daily(db, now.astimezone(timezone.utc))
    except Exception:  # noqa: BLE001
        log.exception("Daily emails failed")


def _loop() -> None:
    while not _stop.wait(TICK_SECONDS):
        try:
            tick()
        except Exception:  # noqa: BLE001
            log.exception("Reminder tick failed")


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="reminders", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
