"""Relational tables shaped after FHIR R4 resources (ABDM / NRCeS profiles).

Each clinical row keeps normalized columns for querying plus `fhir_json`, the
validated FHIR resource that is emitted in ABDM bundles.
"""

import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Account(SQLModel, table=True):
    """A person who signs in. One account can manage several patient profiles (self and family)."""

    id: str = Field(default_factory=new_id, primary_key=True)
    login: str = Field(index=True, unique=True)  # lower-cased email or 10-digit Indian mobile number
    name: str
    password_hash: str
    created_at: datetime = Field(default_factory=utcnow)
    email: str | None = Field(default=None, index=True)  # for codes and alerts; the login itself may be a mobile number
    email_verified_at: datetime | None = None
    phone: str | None = Field(default=None, index=True)  # E.164 mobile number that also signs in
    notify_security: bool = True
    notify_medicines: bool = True
    notify_weekly: bool = True
    last_weekly_at: datetime | None = None


class EmailCode(SQLModel, table=True):
    """A one-time code sent by email. Only a hash is kept; rows stay for an hour to rate-limit new codes."""

    id: str = Field(default_factory=new_id, primary_key=True)
    email: str = Field(index=True)
    purpose: str  # signup | reset | email
    account_id: str | None = Field(default=None, index=True)
    code_hash: str
    payload: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))  # signup: name, login, password_hash
    attempts: int = 0
    used: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime


class Notification(SQLModel, table=True):
    """Emails already sent, so a scheduled job never repeats one."""

    id: str = Field(default_factory=new_id, primary_key=True)
    account_id: str = Field(index=True)
    key: str = Field(index=True)  # e.g. med:<medication id>
    sent_at: datetime = Field(default_factory=utcnow)


class AuthSession(SQLModel, table=True):
    token_hash: str = Field(primary_key=True)  # sha256 of the cookie token; the token itself is never stored
    account_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime


class Patient(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    owner_id: str | None = Field(default=None, index=True)  # Account.id
    name: str
    gender: str | None = None  # male | female | other | unknown (FHIR AdministrativeGender)
    birth_date: date | None = None
    phone: str | None = None  # E.164
    preferred_language: str = "en"
    relationship: str | None = None  # to the account holder: self | spouse | father | mother | son | daughter | ...
    relationship_other: str | None = None  # the user's own word for it when relationship is "other", e.g. "Uncle"
    abha_number: str | None = Field(default=None, index=True)  # 14 digits, XX-XXXX-XXXX-XXXX
    abha_address: str | None = None  # name@abdm
    abha_linked_at: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class Document(SQLModel, table=True):
    """FHIR DocumentReference: the uploaded source file and its processing state."""

    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    filename: str
    mime_type: str
    file_path: str
    source: str = "upload"  # upload | abdm_import
    doc_type: str | None = None  # prescription | lab_report | discharge_summary | imaging_report | other
    status: str = "queued"  # queued | processing | review | confirmed | failed
    stage: str = "queued"
    progress: int = 0
    error: str | None = None
    page_count: int = 0
    page_images: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    languages: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    handwritten: bool = False
    document_date: date | None = None
    facility: str | None = None
    author: str | None = None
    title: str | None = None
    classification: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    raw_extraction: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    verified_extraction: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    review: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    pipeline_log: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    confirmed_at: datetime | None = None
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class Encounter(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    encounter_class: str = "AMB"  # AMB (outpatient) | IMP (inpatient) | EMER
    start_date: date | None = None
    end_date: date | None = None
    facility: str | None = None
    practitioner: str | None = None
    reason: str | None = None
    hospital_course: str | None = None
    procedures: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    discharge_condition: str | None = None
    follow_up: str | None = None
    advice: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class DiagnosticReport(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    category: str = "LAB"  # LAB | RAD
    name: str | None = None
    issued: date | None = None
    performer: str | None = None
    conclusion: str | None = None
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class Observation(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    report_id: str | None = Field(default=None, foreign_key="diagnosticreport.id")
    category: str = "laboratory"  # laboratory | vital-signs
    name_raw: str
    name: str
    loinc: str | None = Field(default=None, index=True)
    panel: str | None = None
    value_num: float | None = None
    value_text: str | None = None
    unit: str | None = None
    value_original: str | None = None
    unit_original: str | None = None
    ref_low: float | None = None
    ref_high: float | None = None
    ref_text: str | None = None
    ref_source: str | None = None  # report | curated
    interpretation: str | None = None  # N | L | H | LL | HH | A
    critical: bool = False
    effective_date: date | None = None
    confidence: float | None = None
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class MedicationRequest(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    name_raw: str
    name: str
    generic: str | None = None
    drug_class: str | None = None
    strength: str | None = None
    form: str | None = None
    dose: str | None = None
    frequency_raw: str | None = None
    frequency_code: str | None = None  # OD | BD | TDS | QID | HS | SOS | STAT | WEEKLY | CUSTOM
    morning: float | None = None
    afternoon: float | None = None
    night: float | None = None
    meal_relation: str | None = None  # before_food | after_food | with_food | empty_stomach | bedtime
    route: str | None = None
    duration_text: str | None = None
    duration_days: int | None = None
    instructions: str | None = None
    prescriber: str | None = None
    authored_on: date | None = None
    status: str = "active"  # active | completed
    confidence: float | None = None
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class Condition(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    name_raw: str
    name: str
    icd10: str | None = None
    icd10_display: str | None = None
    verification_status: str = "confirmed"  # confirmed | provisional
    clinical_status: str = "active"  # active | resolved
    recorded_date: date | None = None
    confidence: float | None = None
    fhir_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


class Summary(SQLModel, table=True):
    """Cached AI summaries, keyed by scope + language + hash of the source data."""

    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    document_id: str | None = Field(default=None, foreign_key="document.id", index=True)
    scope: str  # document | patient
    language: str = "en"
    source_hash: str
    content: dict[str, Any] = Field(sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)


class AbhaSession(SQLModel, table=True):
    """Mock ABHA OTP transaction."""

    txn_id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id")
    abha_number: str | None = None
    abha_address: str | None = None
    otp: str
    created_at: datetime = Field(default_factory=utcnow)
    verified: bool = False


class Reminder(SQLModel, table=True):
    """A repeating medicine reminder, scheduled by the copilot from a prescription or added by the user.

    `slots` holds the daily dose times in IST: [{"time": "08:00", "slot": "morning", "amount": "1 tablet"}].
    """

    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    medication_id: str | None = Field(default=None, index=True)
    title: str
    detail: str | None = None  # e.g. "after food"
    slots: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    weekdays: list[int] | None = Field(default=None, sa_column=Column(JSON))  # 0 = Monday; None = every day
    start_date: date
    end_date: date | None = None  # last day of the course, inclusive
    status: str = "active"  # active | paused | ended | removed
    source: str = "copilot"  # copilot | user
    created_at: datetime = Field(default_factory=utcnow)


class DoseLog(SQLModel, table=True):
    """What happened to one scheduled dose: taken, skipped or snoozed."""

    id: str = Field(default_factory=new_id, primary_key=True)
    reminder_id: str = Field(index=True)
    patient_id: str = Field(index=True)
    day: date = Field(index=True)
    time: str  # the slot's scheduled time, HH:MM
    status: str  # taken | skipped | snoozed
    snooze_until: datetime | None = None
    acted_at: datetime = Field(default_factory=utcnow)


class Appointment(SQLModel, table=True):
    """A doctor visit or a test to repeat, found in a record by the copilot or added by the user."""

    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    kind: str = "visit"  # visit | test
    title: str
    due_date: date
    time: str | None = None  # HH:MM
    doctor: str | None = None
    facility: str | None = None
    notes: str | None = None
    status: str = "upcoming"  # upcoming | done | cancelled
    source: str = "user"  # user | copilot
    source_text: str | None = None  # the words in the record it came from, e.g. "Review after 3 months"
    document_id: str | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utcnow)


class CopilotAction(SQLModel, table=True):
    """Something the copilot did or proposes, shown in its activity feed so the user can keep, edit or reject it."""

    id: str = Field(default_factory=new_id, primary_key=True)
    patient_id: str = Field(foreign_key="patient.id", index=True)
    key: str = Field(index=True)  # dedupe key, e.g. reminders:<document id> or test:hba1c:2026-10-01
    kind: str  # reminders | reminders_stopped | appointment | test_due | overdue | questions
    title: str
    detail: str | None = None
    items: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    ref_ids: list[str] = Field(default_factory=list, sa_column=Column(JSON))  # reminders or appointments it created
    document_id: str | None = None
    status: str = "done"  # done (applied, can be undone) | proposed | kept | accepted | rejected | resolved | superseded
    created_at: datetime = Field(default_factory=utcnow)
    resolved_at: datetime | None = None


class PushSubscription(SQLModel, table=True):
    """A browser or phone that asked for reminder notifications (Web Push)."""

    id: str = Field(default_factory=new_id, primary_key=True)
    account_id: str = Field(index=True)
    endpoint: str = Field(index=True, unique=True)
    keys: dict[str, Any] = Field(sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
