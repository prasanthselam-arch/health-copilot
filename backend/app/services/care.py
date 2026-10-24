"""Health risk insights and preventive next steps, computed in code from the person's own timeline.

Nothing here is a diagnosis. Every insight cites the results it is based on, and every next step is worded as
something to discuss with a doctor. Intervals follow common Indian and international practice (NPCDCS, ADA, RSSDI)
and are shown as "commonly advised", never as an order.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.knowledge import labs
from app.models.tables import Appointment, Condition, MedicationRequest, Observation, Patient
from app.services.facts import FLAG_WORDS, _age
from app.services.records import medication_status

GLUCOSE_LOWERING = {"metformin", "glimepiride", "gliclazide", "glibenclamide", "sitagliptin", "vildagliptin", "teneligliptin",
                    "linagliptin", "dapagliflozin", "empagliflozin", "canagliflozin", "pioglitazone", "voglibose", "acarbose",
                    "insulin", "repaglinide"}
BP_LOWERING = {"telmisartan", "losartan", "olmesartan", "amlodipine", "cilnidipine", "metoprolol", "atenolol", "bisoprolol",
               "ramipril", "enalapril", "hydrochlorothiazide", "chlorthalidone", "nebivolol", "valsartan"}
LIPID_LOWERING = {"atorvastatin", "rosuvastatin", "simvastatin", "fenofibrate", "ezetimibe"}
THYROID = {"levothyroxine", "thyroxine", "carbimazole", "methimazole"}


@dataclass
class Profile:
    patient: Patient
    age: int | None
    sex: str | None
    conditions: set[str]  # ICD-10 prefixes and plain tags
    condition_names: dict[str, str]
    meds: list[MedicationRequest]
    generics: set[str]
    series: dict[str, list[Observation]]  # lab key -> results, oldest first

    def has(self, *tags: str) -> bool:
        return any(t in self.conditions for t in tags)

    def latest(self, key: str) -> Observation | None:
        s = self.series.get(key)
        return s[-1] if s else None

    def value(self, key: str) -> float | None:
        o = self.latest(key)
        return o.value_num if o else None

    def on(self, group: set[str]) -> list[MedicationRequest]:
        return [m for m in self.meds if any(g in (m.generic or m.name).lower() for g in group)]


def build_profile(db: Session, p: Patient) -> Profile:
    conds = db.exec(select(Condition).where(Condition.patient_id == p.id)).all()
    tags, names = set(), {}
    for c in conds:
        code = (c.icd10 or "").upper()
        name = c.name.lower()
        for tag, prefixes, words in (
            ("diabetes", ("E10", "E11", "E13", "E14"), ("diabet", "t2dm", "dm2")),
            ("prediabetes", ("R73",), ("prediabet",)),
            ("hypertension", ("I10", "I11", "I12", "I15"), ("hypertension", "htn")),
            ("lipids", ("E78",), ("lipid", "cholesterol")),
            ("hypothyroid", ("E03", "E02"), ("hypothyroid",)),
            ("hyperthyroid", ("E05",), ("hyperthyroid", "thyrotox")),
            ("anaemia", ("D50", "D51", "D52", "D53", "D64"), ("anaemia", "anemia")),
            ("ckd", ("N18",), ("kidney disease", "ckd")),
            ("heart", ("I20", "I21", "I25", "I50", "I48"), ("coronary", "angina", "heart")),
            ("asthma_copd", ("J45", "J44"), ("asthma", "copd")),
            ("obesity", ("E66",), ("obes",)),
            ("fatty_liver", ("K76.0",), ("fatty liver",)),
            ("gout", ("M10", "E79"), ("gout", "uric")),
            ("vitd", ("E55",), ("vitamin d",)),
        ):
            if code.startswith(prefixes) or any(w in name for w in words):
                tags.add(tag)
                names.setdefault(tag, c.name)
    meds = [m for m in db.exec(select(MedicationRequest).where(MedicationRequest.patient_id == p.id)).all()
            if medication_status(m) == "active"]
    generics = {(m.generic or m.name).lower() for m in meds}
    prof = Profile(p, _age(p), p.gender, tags, names, meds, generics, {})
    if prof.on(GLUCOSE_LOWERING):
        tags.add("diabetes_meds")
    if prof.on(BP_LOWERING):
        tags.add("bp_meds")
    by_loinc = labs().by_loinc
    rows = db.exec(select(Observation).where(Observation.patient_id == p.id, Observation.value_num.is_not(None))).all()  # type: ignore[union-attr]
    series: dict[str, list[Observation]] = defaultdict(list)
    for o in rows:
        t = by_loinc.get(o.loinc or "")
        series[t.key if t else o.name.lower()].append(o)
    for k in series:
        series[k].sort(key=lambda o: (o.effective_date or date.min))
        # one point per day: a later document of the same day replaces an earlier one
        dedup: dict[date | None, Observation] = {}
        for o in series[k]:
            dedup[o.effective_date] = o
        series[k] = list(dedup.values())
    prof.series = dict(series)
    return prof


def ev(o: Observation) -> dict[str, Any]:
    return {"id": o.id, "test": o.name, "value": o.value_num if o.value_num is not None else o.value_text, "unit": o.unit,
            "date": o.effective_date.isoformat() if o.effective_date else None, "flag": FLAG_WORDS.get(o.interpretation or ""),
            "document_id": o.document_id}


def _v(o: Observation) -> str:
    return f"{o.value_num:g}" + (f" {o.unit}" if o.unit and o.unit != "%" else "%" if o.unit == "%" else "")


def _d(o: Observation) -> str:
    return o.effective_date.strftime("%d %b %Y") if o.effective_date else "an undated report"


def _high(o: Observation) -> bool:
    return o.interpretation in ("H", "HH")


def _low(o: Observation) -> bool:
    return o.interpretation in ("L", "LL")


def _name(key: str, o: Observation) -> str:
    t = labs().tests.get(key)
    return t.display if t else o.name


# ---------------------------------------------------------------- insights

def insights(prof: Profile) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    out.extend(_series_insights(prof))
    out.extend(_combination_insights(prof))
    rank = {"attention": 0, "watch": 1, "good": 2}
    seen, unique = set(), []
    for i in sorted(out, key=lambda i: (rank[i["level"]], -len(i["evidence"]))):
        if i["key"] not in seen:
            seen.add(i["key"])
            unique.append(i)
    return unique


def _series_insights(prof: Profile) -> list[dict[str, Any]]:
    out = []
    for key, s in prof.series.items():
        if key in ("height", "pulse", "temperature", "resp_rate", "spo2"):
            continue
        last = s[-1]
        name = _name(key, last)
        flagged = [o for o in s if o.interpretation and o.interpretation != "N"]
        run: list[Observation] = []
        for o in reversed(s):
            if (o.interpretation or "N") == "N" or (run and _high(o) != _high(run[0])):
                break
            run.append(o)
        run.reverse()
        if len(s) >= 2:
            first, prev = s[0], s[-2]
            change = (last.value_num or 0) - (prev.value_num or 0)
            pct = change / prev.value_num * 100 if prev.value_num else 0
            bad_up = _high(last) or (not _low(last) and any(_high(o) for o in flagged))
            bad_down = _low(last) or (not _high(last) and any(_low(o) for o in flagged))
            pts = s[-4:]
            journey = " → ".join(f"{_v(o)} ({o.effective_date:%b %Y})" if o.effective_date else _v(o) for o in pts)
            if len(run) >= 2:
                direction = "above" if _high(last) else "below"
                moving = (" and still rising" if _high(last) and pct >= 3 else " and still falling" if _low(last) and pct <= -3
                          else " though it has improved a little" if (_high(last) and pct <= -3) or (_low(last) and pct >= 3) else "")
                out.append(_insight(
                    f"persistent:{key}", "persistent", "attention",
                    f"{name} has stayed {direction} the usual range",
                    f"{name} was {direction} the usual range in your last {len(run)} reports{moving}: {journey}.",
                    run[-4:], key,
                    next_step=f"Show these {name} results to your doctor at your next visit and ask whether your plan needs a review.",
                    question=f"My {name} has been {direction} range in my last {len(run)} reports ({' → '.join(_v(o) for o in run[-4:])}). "
                             "What should my target be, and does my plan need to change?",
                ))
            elif (bad_up and pct >= 5) or (bad_down and pct <= -5):
                out.append(_insight(
                    f"trend:{key}", "trend", "attention" if (last.interpretation or "N") != "N" else "watch",
                    f"{name} is moving the wrong way",
                    f"{name} went from {_v(prev)} on {_d(prev)} to {_v(last)} on {_d(last)} ({pct:+.0f}%).",
                    pts, key,
                    next_step=f"Ask your doctor about this change in {name} and when to test it again.",
                    question=f"My {name} changed from {_v(prev)} to {_v(last)}. Is this change important, and when should I repeat the test?",
                ))
            elif flagged and (last.interpretation or "N") == "N" and (prev.interpretation or "N") != "N":
                out.append(_insight(
                    f"improving:{key}", "improving", "good",
                    f"{name} is back in the usual range",
                    f"{name} was {FLAG_WORDS.get(prev.interpretation or '', 'outside range')} at {_v(prev)} on {_d(prev)} and is now "
                    f"{_v(last)} ({_d(last)}), within the usual range. Keep up what you are doing.",
                    [prev, last], key,
                ))
            elif flagged and ((bad_up and pct <= -5) or (bad_down and pct >= 5)):
                out.append(_insight(
                    f"improving:{key}", "improving", "good",
                    f"{name} is improving",
                    f"{name} moved from {_v(prev)} ({_d(prev)}) to {_v(last)} ({_d(last)}), towards the usual range.",
                    [prev, last], key,
                ))
            elif len(s) >= 3 and all((o.interpretation or "N") == "N" for o in s[-3:]) and last.ref_high and first.value_num:
                rising = all((s[i].value_num or 0) < (s[i + 1].value_num or 0) for i in range(len(s) - 3, len(s) - 1))
                if rising and (last.value_num or 0) >= 0.9 * last.ref_high:
                    out.append(_insight(
                        f"nearing:{key}", "trend", "watch", f"{name} is creeping up towards the upper limit",
                        f"{name} is still within range but has risen in each of your last 3 reports: {journey}. "
                        f"The upper limit is {last.ref_high:g}.", s[-3:], key,
                        next_step=f"Mention the rising {name} to your doctor.",
                        question=f"My {name} has risen in each of my last three reports while staying in range. Should I watch it more closely?",
                    ))
        elif (last.interpretation or "N") in ("HH", "LL"):
            out.append(_insight(
                f"critical:{key}", "range", "attention", f"{name} was at a critical level",
                f"{name} was {_v(last)} on {_d(last)}, far outside the usual range.", [last], key,
                next_step="Contact your doctor promptly about this result if you have not already.",
                question=f"My {name} was {_v(last)} on {_d(last)}. What should I do about it now?",
            ))
    return out


def _combination_insights(prof: Profile) -> list[dict[str, Any]]:
    out = []
    a1c, fbg, ldl = prof.latest("hba1c"), prof.latest("glucose_fasting"), prof.latest("ldl")
    tg, hdl, hb = prof.latest("triglycerides"), prof.latest("hdl"), prof.latest("hemoglobin")
    ferr, mcv, b12 = prof.latest("ferritin"), prof.latest("mcv"), prof.latest("vitamin_b12")
    cr, egfr, tsh, alt = prof.latest("creatinine"), prof.latest("egfr"), prof.latest("tsh"), prof.latest("alt")
    diabetic = prof.has("diabetes", "diabetes_meds")

    sugar_high = [o for o in (a1c, fbg) if o and o.value_num is not None and
                  ((o is a1c and o.value_num >= 6.5) or (o is fbg and o.value_num >= 126))]
    if sugar_high and not diabetic:
        out.append(_insight(
            "combo:sugar_range", "combination", "attention", "Your sugar results are in the range doctors check for diabetes",
            "Your " + " and ".join(f"{o.name} of {_v(o)} ({_d(o)})" for o in sugar_high) +
            " are at levels where doctors usually confirm with a repeat test. Only a doctor can say what this means for you.",
            sugar_high, "hba1c",
            next_step="Book a visit with your doctor to discuss these sugar results and a confirmatory test.",
            question="My sugar results were in the range you check for diabetes. Do I need a confirmatory test?",
        ))
    elif a1c and a1c.value_num and 5.7 <= a1c.value_num < 6.5 and not diabetic:
        out.append(_insight(
            "combo:prediabetes_range", "combination", "watch", "Your HbA1c is in the 'prediabetes' range",
            f"An HbA1c of {_v(a1c)} ({_d(a1c)}) is between 5.7% and 6.4%, where lifestyle changes can make a big difference.",
            [a1c], "hba1c", next_step="Ask your doctor how often to recheck your HbA1c.",
            question=f"My HbA1c is {_v(a1c)}. What can I do to keep it from rising?",
        ))
    if (diabetic or sugar_high) and ldl and ldl.value_num and ldl.value_num >= 100:
        out.append(_insight(
            "combo:sugar_ldl", "combination", "attention", "High sugar and high LDL together",
            f"Your LDL ('bad') cholesterol was {_v(ldl)} ({_d(ldl)}) alongside {'diabetes in your records' if diabetic else 'high sugar results'}. "
            "Doctors pay extra attention to this pair because together they raise the risk of heart disease.",
            [x for x in (ldl, a1c or fbg) if x], "ldl",
            next_step="Ask your doctor what LDL target suits you and how to reach it.",
            question=f"With my sugar and an LDL of {_v(ldl)}, what LDL target should I aim for?",
        ))
    if tg and hdl and _high(tg) and _low(hdl):
        out.append(_insight(
            "combo:tg_hdl", "combination", "watch", "High triglycerides with low HDL",
            f"Triglycerides {_v(tg)} with HDL ('good' cholesterol) {_v(hdl)}. This pattern is often linked to diet, weight and blood sugar.",
            [tg, hdl], "triglycerides", next_step="Discuss this cholesterol pattern with your doctor.",
            question="My triglycerides are high and HDL is low. What changes matter most for me?",
        ))
    if hb and _low(hb):
        low_iron = [o for o in (ferr, mcv) if o and _low(o)]
        if low_iron:
            out.append(_insight(
                "combo:iron_pattern", "combination", "attention", "Low haemoglobin with signs of low iron",
                f"Haemoglobin {_v(hb)} with low {' and '.join(o.name for o in low_iron)}. Doctors often check for iron deficiency with this pattern.",
                [hb, *low_iron], "hemoglobin", next_step="Ask your doctor whether you need iron studies or treatment for this.",
                question="My haemoglobin and iron markers are low. What could be causing it, and what should I do?",
            ))
        elif (mcv and _high(mcv)) or (b12 and _low(b12)):
            other = [o for o in (mcv, b12) if o and (_high(o) if o is mcv else _low(o))]
            out.append(_insight(
                "combo:b12_pattern", "combination", "attention", "Low haemoglobin with signs of low B12 or folate",
                f"Haemoglobin {_v(hb)} with {' and '.join(f'{o.name} {_v(o)}' for o in other)}. This pattern is often checked for vitamin B12 or folate deficiency.",
                [hb, *other], "hemoglobin", next_step="Ask your doctor about B12 and folate tests.",
                question="Could my low haemoglobin be due to vitamin B12 or folate?",
            ))
    kidney = [o for o in (cr, egfr) if o and ((o is cr and _high(o)) or (o is egfr and o.value_num is not None and o.value_num < 60))]
    if kidney and (diabetic or prof.has("hypertension", "bp_meds")):
        on_met = prof.on({"metformin"})
        out.append(_insight(
            "combo:kidney", "combination", "attention", "Kidney results need a look alongside sugar or BP",
            f"{' and '.join(f'{o.name} {_v(o)} ({_d(o)})' for o in kidney)} with "
            f"{'diabetes' if diabetic else 'high blood pressure'} in your records."
            + (" Some medicines you take, such as metformin, are checked against kidney results." if on_met else ""),
            kidney, "creatinine",
            next_step="Ask your doctor to review your kidney results" + (" and your medicines" if on_met else "") + ". Do not change any medicine yourself.",
            question="My kidney results are outside range. Do my medicines need a review because of this?",
        ))
    if tsh and tsh.interpretation not in (None, "N") and prof.on(THYROID):
        out.append(_insight(
            "combo:thyroid_treated", "combination", "watch", "TSH is outside range while on thyroid medicine",
            f"Your TSH was {_v(tsh)} ({_d(tsh)}) while you take {prof.on(THYROID)[0].name}. Doctors use TSH to judge whether the dose fits.",
            [tsh], "tsh", next_step="Show this TSH result to your doctor; do not change the dose yourself.",
            question=f"My TSH is {_v(tsh)} on my current thyroid medicine. Does the dose need review?",
        ))
    if alt and _high(alt) and ((tg and _high(tg)) or prof.has("fatty_liver", "obesity")):
        out.append(_insight(
            "combo:liver_metabolic", "combination", "watch", "Liver enzyme raised with metabolic signs",
            f"ALT {_v(alt)} ({_d(alt)}) together with {'high triglycerides' if tg and _high(tg) else prof.condition_names.get('fatty_liver') or 'weight concerns'}. "
            "This combination is often linked to fat in the liver.", [x for x in (alt, tg) if x], "alt",
            next_step="Ask your doctor whether a liver scan or repeat test is needed.",
            question="My ALT is high along with my triglycerides. Could this be fatty liver?",
        ))
    return out


def _insight(key: str, kind: str, level: str, title: str, body: str, obs: list[Observation], test: str,
             next_step: str | None = None, question: str | None = None) -> dict[str, Any]:
    return {"key": key, "kind": kind, "level": level, "title": title, "body": body, "evidence": [ev(o) for o in obs],
            "test": test, "next_step": next_step, "question": question}


# ---------------------------------------------------------------- preventive next steps

@dataclass
class Retest:
    key: str
    label: str
    tests: tuple[str, ...]
    words: tuple[str, ...]  # how a doctor's note or an appointment names it


RETESTS = [
    Retest("hba1c", "HbA1c (3-month sugar average)", ("hba1c",), ("hba1c", "a1c", "glycated")),
    Retest("lipids", "Lipid profile (cholesterol)", ("ldl", "cholesterol_total", "triglycerides", "hdl"), ("lipid", "cholesterol")),
    Retest("kidney", "Kidney function (creatinine / eGFR)", ("creatinine", "egfr", "urea"), ("kidney", "creatinine", "kft", "rft", "egfr")),
    Retest("cbc", "Haemoglobin / complete blood count", ("hemoglobin",), ("cbc", "blood count", "haemoglobin", "hemoglobin", " hb")),
    Retest("thyroid", "Thyroid test (TSH)", ("tsh",), ("tsh", "thyroid")),
    Retest("vitd", "Vitamin D", ("vitamin_d",), ("vitamin d", "vit d")),
    Retest("b12", "Vitamin B12", ("vitamin_b12",), ("b12",)),
    Retest("liver", "Liver function test", ("alt", "ast"), ("lft", "liver")),
    Retest("uric", "Uric acid", ("uric_acid",), ("uric",)),
]


def planned_by(r: Retest, appointments: list[Appointment]) -> Appointment | None:
    """An upcoming test or visit that already covers this repeat test."""
    for a in appointments:
        if a.status == "upcoming":
            text = f" {a.title} {a.source_text or ''}".lower()
            if any(w in text for w in r.words):
                return a
    return None


def _retest_interval(prof: Profile, r: Retest) -> tuple[int, str] | None:
    """(days, why) if this person would commonly be advised to repeat the test, else None."""
    lasts = [prof.latest(t) for t in r.tests if prof.latest(t)]
    abnormal = any(o.interpretation not in (None, "N") for o in lasts)
    a1c = prof.value("hba1c")
    diabetic = prof.has("diabetes", "diabetes_meds")
    if r.key == "hba1c":
        if diabetic and a1c is not None and a1c >= 7:
            return 90, "With diabetes and an HbA1c above 7%, it is commonly rechecked every 3 months."
        if diabetic:
            return 180, "With diabetes, HbA1c is commonly checked every 3 to 6 months."
        if a1c is not None and a1c >= 5.7:
            return 365, "An HbA1c in the prediabetes range is commonly rechecked every year."
        return None
    if r.key == "lipids":
        if abnormal or prof.on(LIPID_LOWERING):
            return 180, "Cholesterol outside range or on cholesterol medicine is commonly rechecked in 3 to 6 months."
        if diabetic or prof.has("hypertension", "heart"):
            return 365, "With diabetes, BP or heart conditions, a lipid profile is commonly done every year."
        return None
    if r.key == "kidney":
        if abnormal:
            return 90, "Kidney results outside range are commonly rechecked within about 3 months."
        if diabetic or prof.has("hypertension", "bp_meds", "ckd") or prof.on({"metformin"}):
            return 365, "With diabetes, BP or metformin, kidney function is commonly checked every year."
        return None
    if r.key in ("cbc", "vitd", "b12", "uric", "liver"):
        if abnormal:
            return 90 if r.key in ("cbc", "vitd", "b12") else 180, f"A {r.label.split(' (')[0].lower()} result outside range is commonly rechecked after treatment or lifestyle changes."
        return None
    if r.key == "thyroid":
        if prof.on(THYROID) or abnormal:
            return 180, "On thyroid medicine or with an abnormal TSH, it is commonly rechecked every 6 months (sooner after a dose change)."
        return None
    return None


def preventive(prof: Profile, appointments: list[Appointment], today: date) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in RETESTS:
        rule = _retest_interval(prof, r)
        if not rule or planned_by(r, appointments):
            continue
        days, why = rule
        lasts = [prof.latest(t) for t in r.tests if prof.latest(t)]
        last = max(lasts, key=lambda o: o.effective_date or date.min) if lasts else None
        if not last or not last.effective_date:
            out.append({"key": f"test:{r.key}", "kind": "repeat_test", "title": r.label, "why": why, "status": "not_done",
                        "due_date": today.isoformat(), "last_date": None, "interval_days": days, "evidence": [],
                        "source": "Commonly advised (ADA / RSSDI)"})
            continue
        due = last.effective_date + timedelta(days=days)
        status = "overdue" if due < today else "due_soon" if due <= today + timedelta(days=30) else "ok"
        out.append({"key": f"test:{r.key}", "kind": "repeat_test", "title": r.label, "why": why, "status": status,
                    "due_date": due.isoformat(), "last_date": last.effective_date.isoformat(), "interval_days": days,
                    "evidence": [ev(o) for o in lasts], "source": "Commonly advised (ADA / RSSDI)"})
    for a in appointments:
        if a.status != "upcoming":
            continue
        status = "overdue" if a.due_date < today else "due_soon" if a.due_date <= today + timedelta(days=14) else "ok"
        out.append({"key": f"appt:{a.id}", "kind": "follow_up" if a.kind == "visit" else "repeat_test", "title": a.title,
                    "why": f"From your record: \u201c{a.source_text}\u201d" if a.source_text else "Added by you",
                    "status": status, "due_date": a.due_date.isoformat(), "last_date": None, "interval_days": None,
                    "evidence": [], "appointment_id": a.id, "document_id": a.document_id, "source": "Your records"})
    out.extend(screenings(prof))
    rank = {"overdue": 0, "not_done": 1, "due_soon": 2, "ask": 3, "ok": 4}
    return sorted(out, key=lambda x: (rank.get(x["status"], 5), x.get("due_date") or "9999"))


def screenings(prof: Profile) -> list[dict[str, Any]]:
    """Age, sex and condition-based checks to ask a doctor about. They are not tests found in the records."""
    age, sex = prof.age, prof.sex
    items = []

    def add(key: str, title: str, why: str, source: str) -> None:
        items.append({"key": f"screen:{key}", "kind": "screening", "title": title, "why": why, "status": "ask",
                      "due_date": None, "last_date": None, "interval_days": None, "evidence": [], "source": source})

    diabetic = prof.has("diabetes", "diabetes_meds")
    if diabetic:
        add("eye", "Diabetic eye check (retina exam)", "With diabetes, a dilated eye exam is commonly advised every year.", "ADA / RSSDI")
        add("foot", "Foot check", "With diabetes, a foot check for numbness or sores is commonly advised at least every year.", "ADA / RSSDI")
        add("acr", "Urine albumin test (ACR)", "With diabetes, a urine albumin test for early kidney changes is commonly advised every year.", "ADA / RSSDI")
    if prof.has("hypertension", "bp_meds"):
        add("home_bp", "Home blood pressure log", "With high blood pressure, checking BP at home and showing the log to your doctor helps.", "ISH / API")
    if age is not None and age >= 30:
        if not diabetic and "hba1c" not in prof.series and "glucose_fasting" not in prof.series:
            add("sugar", "Blood sugar screening", "From age 30, a yearly sugar check is advised in India's national screening programme.", "NPCDCS (India)")
        if not prof.has("hypertension", "bp_meds"):
            add("bp", "Blood pressure check", "From age 30, a yearly blood pressure check is advised in India's national screening programme.", "NPCDCS (India)")
        add("oral", "Oral cancer screening", "From age 30, a mouth check is advised, especially for anyone who uses tobacco.", "NPCDCS (India)")
        if sex == "female":
            if age <= 65:
                add("cervix", "Cervical cancer screening", "Women aged 30 to 65 are advised a cervical screen (VIA / Pap / HPV) every 5 years.", "NPCDCS (India)")
            add("breast", "Breast examination", "Women from age 30 are advised a clinical breast exam; ask about mammography from 40.", "NPCDCS (India)")
    if age is not None and age >= 50:
        add("colon", "Bowel cancer screening (ask your doctor)", "From about age 50, ask your doctor whether a stool test or colonoscopy suits you.", "USPSTF")
    if age is not None and ((sex == "female" and age >= 65) or (sex == "male" and age >= 70)):
        add("bone", "Bone density (DEXA) scan", "Bone thinning is common at this age; a bone density scan is commonly advised.", "USPSTF")
    if (age is not None and age >= 60) or prof.has("asthma_copd", "diabetes", "heart"):
        add("flu", "Yearly flu vaccine", "Recommended every year for people aged 60+ or with diabetes, heart or lung conditions.", "WHO / API")
    if age is not None and age >= 60:
        add("eyes_hearing", "Eye and hearing check", "From age 60, a yearly vision and hearing check helps prevent falls and isolation.", "NPHCE (India)")
    return items


def care_overview(db: Session, p: Patient, today: date) -> dict[str, Any]:
    from app.services import reminders, wellness

    prof = build_profile(db, p)
    appts = list(db.exec(select(Appointment).where(Appointment.patient_id == p.id)).all())
    return {
        "insights": insights(prof),
        "preventive": preventive(prof, appts, today),
        "wellness": wellness.recommendations(prof),
        "adherence": reminders.adherence(db, p, today=today),
        "profile": {"age": prof.age, "gender": prof.sex, "conditions": sorted(prof.condition_names.values())},
    }
