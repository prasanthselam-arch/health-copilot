"""Personalised lifestyle guidance: a curated library of general wellness tips, picked by code from the person's
conditions, test results and age. Each tip says why it was suggested, citing the records behind it.

The tips are general wellness advice (diet, activity, sleep, habits) written for Indian homes. They never mention
medicine doses and always leave treatment decisions to the doctor.
"""

from dataclasses import dataclass, field
from typing import Any, Callable

from app.models.tables import Observation
from app.services.care import Profile, _d, _v, ev

CATEGORIES = ("diet", "activity", "sleep", "habits", "monitoring")


@dataclass
class Tip:
    key: str
    category: str
    title: str
    body: str
    # returns (why, supporting results) when the tip applies to this person, else None
    when: Callable[[Profile], tuple[str, list[Observation]] | None]
    priority: int = 2
    tags: list[str] = field(default_factory=list)


def _flag(prof: Profile, key: str, high: bool) -> Observation | None:
    o = prof.latest(key)
    if o and o.interpretation in (("H", "HH") if high else ("L", "LL")):
        return o
    return None


def _sugar(prof: Profile) -> tuple[str, list[Observation]] | None:
    a1c, fbg = prof.latest("hba1c"), prof.latest("glucose_fasting")
    high = [o for o in (a1c, fbg) if o and o.interpretation in ("H", "HH")]
    if high:
        return "because your " + " and ".join(f"{o.name} was {_v(o)} on {_d(o)}" for o in high), high
    if prof.has("diabetes", "diabetes_meds", "prediabetes"):
        return f"because your records list {prof.condition_names.get('diabetes') or prof.condition_names.get('prediabetes') or 'sugar medicines'}", []
    return None


def _ldl(prof: Profile) -> tuple[str, list[Observation]] | None:
    hits = [o for o in (_flag(prof, "ldl", True), _flag(prof, "cholesterol_total", True)) if o]
    if hits:
        return "because your " + " and ".join(f"{o.name} was {_v(o)} on {_d(o)}" for o in hits), hits
    if prof.has("lipids"):
        return f"because your records list {prof.condition_names['lipids']}", []
    return None


def _tg(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "triglycerides", True)
    return (f"because your triglycerides were {_v(o)} on {_d(o)}", [o]) if o else None


def _bp(prof: Profile) -> tuple[str, list[Observation]] | None:
    s = _flag(prof, "bp_systolic", True) or _flag(prof, "bp_diastolic", True)
    if s:
        return f"because your blood pressure reading was high on {_d(s)}", [s]
    if prof.has("hypertension", "bp_meds"):
        return f"because your records list {prof.condition_names.get('hypertension') or 'blood pressure medicines'}", []
    return None


def _anaemia(prof: Profile) -> tuple[str, list[Observation]] | None:
    hits = [o for o in (_flag(prof, "hemoglobin", False), _flag(prof, "ferritin", False)) if o]
    if hits:
        return "because your " + " and ".join(f"{o.name} was {_v(o)} on {_d(o)}" for o in hits), hits
    if prof.has("anaemia"):
        return f"because your records list {prof.condition_names['anaemia']}", []
    return None


def _vitd(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "vitamin_d", False)
    if o:
        return f"because your vitamin D was {_v(o)} on {_d(o)}", [o]
    return ("because your records list vitamin D deficiency", []) if prof.has("vitd") else None


def _b12(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "vitamin_b12", False)
    return (f"because your vitamin B12 was {_v(o)} on {_d(o)}", [o]) if o else None


def _uric(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "uric_acid", True)
    if o:
        return f"because your uric acid was {_v(o)} on {_d(o)}", [o]
    return ("because your records list gout or high uric acid", []) if prof.has("gout") else None


def _liver(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "alt", True) or _flag(prof, "ast", True)
    if o:
        return f"because your {o.name} was {_v(o)} on {_d(o)}", [o]
    return ("because your records mention fatty liver", []) if prof.has("fatty_liver") else None


def _kidney(prof: Profile) -> tuple[str, list[Observation]] | None:
    o = _flag(prof, "creatinine", True)
    e = prof.latest("egfr")
    if e and e.value_num is not None and e.value_num < 60:
        o = o or e
    if o:
        return f"because your {o.name} was {_v(o)} on {_d(o)}", [o]
    return ("because your records list kidney disease", []) if prof.has("ckd") else None


def _thyroid(prof: Profile) -> tuple[str, list[Observation]] | None:
    from app.services.care import THYROID

    meds = prof.on(THYROID)
    return (f"because you take {meds[0].name}", []) if meds else None


def _weight(prof: Profile) -> tuple[str, list[Observation]] | None:
    b = prof.latest("bmi")
    if b and b.value_num and b.value_num >= 23:
        return f"because your BMI was {b.value_num:g} on {_d(b)} (for Indian adults, 23 and above is considered overweight)", [b]
    return ("because your records mention obesity", []) if prof.has("obesity") else None


def _age(min_age: int) -> Callable[[Profile], tuple[str, list[Observation]] | None]:
    return lambda prof: (f"because you are {prof.age}", []) if prof.age is not None and prof.age >= min_age else None


def _heart_risk(prof: Profile) -> tuple[str, list[Observation]] | None:
    for f in (_sugar, _ldl, _bp):
        r = f(prof)
        if r:
            return r
    return None


def _always(prof: Profile) -> tuple[str, list[Observation]] | None:
    return "good for everyone, and it helps every other part of your plan", []


def _resp(prof: Profile) -> tuple[str, list[Observation]] | None:
    return (f"because your records list {prof.condition_names['asthma_copd']}", []) if prof.has("asthma_copd") else None


TIPS: list[Tip] = [
    Tip("plate", "diet", "Build a 'half-plate' of vegetables",
        "Fill half your plate with vegetables or salad, a quarter with dal, paneer, egg, fish or chicken, and a quarter with "
        "rice or roti. Prefer whole grains and millets (ragi, jowar, bajra) over white rice and maida.", _sugar, 1),
    Tip("sweets", "diet", "Cut sugary drinks and sweets",
        "Skip sugar in tea and coffee, soft drinks, packaged juices and sweets. Have whole fruit instead of juice, "
        "one portion at a time.", _sugar, 1),
    Tip("walk_after_meals", "activity", "Walk 10 to 15 minutes after meals",
        "A short walk after lunch and dinner helps the body handle sugar from the meal. Aim for 150 minutes of brisk "
        "walking a week in total.", _sugar, 1),
    Tip("fats", "diet", "Choose healthier fats",
        "Limit fried snacks, vanaspati, bakery items and red meat. Use small amounts of oils like mustard, groundnut or "
        "rice-bran, and add oats, nuts, flaxseed and beans, which help lower LDL.", _ldl, 1),
    Tip("tg_carbs", "diet", "Ease off refined carbs and alcohol",
        "Triglycerides respond quickly to less sugar, white rice, maida and alcohol. Even a few weeks of change can show "
        "on the next test.", _tg, 1),
    Tip("salt", "diet", "Keep salt to one teaspoon a day",
        "That is about 5 g in total, including cooking. Go easy on pickles, papad, namkeen, sauces and packaged foods, "
        "which hide a lot of salt.", _bp, 1),
    Tip("home_bp", "monitoring", "Keep a simple BP diary",
        "If your doctor has asked you to, check your BP at the same time each day, seated and rested, and bring the "
        "notes to your visit.", _bp, 2),
    Tip("iron_foods", "diet", "Add iron-rich foods with vitamin C",
        "Green leafy vegetables, rajma, chana, lentils, ragi, eggs, fish and meat are good sources. A squeeze of lemon or "
        "a fruit like amla or orange with the meal helps absorption; keep tea and coffee an hour away from meals.", _anaemia, 1),
    Tip("sunlight", "habits", "Get some morning sunlight",
        "15 to 20 minutes of sun on the arms and face in the morning or late afternoon, a few days a week, helps the body "
        "make vitamin D. Milk, curd, eggs and fish also help.", _vitd, 2),
    Tip("b12_foods", "diet", "Include B12 foods every day",
        "Milk, curd, paneer, eggs, fish and meat supply vitamin B12. People who eat no animal foods are most at risk.", _b12, 2),
    Tip("uric_water", "diet", "Drink enough water; limit red meat and alcohol",
        "Aim for 8 to 10 glasses of water a day unless your doctor has limited fluids. Organ meat, red meat, beer and "
        "sugary drinks raise uric acid.", _uric, 2),
    Tip("liver", "habits", "Be kind to your liver",
        "Avoid alcohol, cut fried and sugary foods, and aim to lose a little weight if you are overweight. Even 5% weight "
        "loss can improve liver tests.", _liver, 1),
    Tip("kidney_otc", "habits", "Ask before taking painkillers",
        "Some over-the-counter painkillers can strain the kidneys. Check with your doctor or pharmacist before taking "
        "any, and stay well hydrated unless told otherwise.", _kidney, 1),
    Tip("thyroid_routine", "habits", "Keep a steady thyroid routine",
        "Take your thyroid tablet the way it was prescribed, at the same time every day. Keep tea, coffee, calcium and "
        "iron tablets apart from it as your doctor advised.", _thyroid, 2),
    Tip("weight", "activity", "Aim for steady, small weight loss",
        "Losing 5 to 7% of your weight over a few months improves sugar, BP and cholesterol. Combine portion control with "
        "daily walking and two days of strength exercise.", _weight, 1),
    Tip("strength_balance", "activity", "Add balance and strength exercises",
        "Simple exercises like standing from a chair, heel-to-toe walking and light weights twice a week keep muscles "
        "strong and prevent falls.", _age(60), 2),
    Tip("falls", "habits", "Make the home fall-safe",
        "Good lighting at night, non-slip mats in the bathroom and a handrail on stairs help prevent falls.", _age(65), 3),
    Tip("heart_smoke", "habits", "Stay away from tobacco",
        "Smoking, beedi and chewing tobacco multiply the heart risk from sugar, BP and cholesterol. Free help is "
        "available on the national quitline, 1800-11-2356.", _heart_risk, 2),
    Tip("resp_smoke", "habits", "Avoid smoke and dust",
        "Keep away from cigarette smoke, chulha smoke, incense and dust, and wear a mask on high-pollution days.", _resp, 2),
    Tip("sleep", "sleep", "Sleep 7 to 8 hours",
        "Regular sleep and wake times help blood sugar, BP and mood. Keep screens away for 30 minutes before bed and "
        "have dinner at least two hours before sleeping.", _always, 3),
    Tip("move", "activity", "Move every day",
        "Aim for 30 minutes of brisk walking or any activity you enjoy on most days, and stand up for a few minutes every "
        "hour of sitting.", _always, 3),
]


def recommendations(prof: Profile, limit: int = 9) -> list[dict[str, Any]]:
    out = []
    for tip in TIPS:
        hit = tip.when(prof)
        if not hit:
            continue
        why, obs = hit
        out.append({"key": tip.key, "category": tip.category, "title": tip.title, "body": tip.body,
                    "why": why[:1].upper() + why[1:] + ".", "evidence": [ev(o) for o in obs], "priority": tip.priority})
    out.sort(key=lambda t: (t["priority"], CATEGORIES.index(t["category"])))
    picked, per_cat = [], {}
    for t in out:
        if per_cat.get(t["category"], 0) >= 3:
            continue
        per_cat[t["category"]] = per_cat.get(t["category"], 0) + 1
        picked.append(t)
    return picked[:limit]
