export interface Account {
  id: string
  name: string
  login: string
  created_at: string
  /** Where codes and alerts go; the login itself may be a mobile number. */
  email: string | null
  email_verified: boolean
  /** E.164 mobile number that also signs in. */
  phone: string | null
  notify: { security: boolean; medicines: boolean; weekly: boolean }
}

/** Reply when an email code was sent. `dev_code` only comes from local servers without an email provider. */
export interface CodeSent {
  sent_to?: string
  expires_in: number
  resend_in: number
  dev_code?: string
}

export const RELATIONSHIPS = [
  'self', 'spouse', 'father', 'mother', 'son', 'daughter', 'brother', 'sister',
  'grandfather', 'grandmother', 'grandson', 'granddaughter', 'father_in_law', 'mother_in_law', 'other',
] as const
export type Relationship = (typeof RELATIONSHIPS)[number]

export type Lang = 'en' | 'hi' | 'bn' | 'mr' | 'te' | 'ta' | 'gu' | 'ur' | 'kn' | 'or' | 'ml' | 'pa' | 'as'
export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' | null

export interface Patient {
  id: string
  name: string
  gender: string | null
  birth_date: string | null
  phone: string | null
  preferred_language: Lang
  relationship: Relationship | null
  relationship_other: string | null
  abha_number: string | null
  abha_address: string | null
  abha_linked_at: string | null
  created_at: string
}

export interface Issue {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string | null
}

export interface ReviewItem {
  id: string
  confidence: number
  needs_review: boolean
  verified: 'agreed' | 'corrected' | 'added' | 'single_pass'
  page: number | null
  issues: Issue[]
}

export interface ReviewMedication extends ReviewItem {
  name_raw: string
  name: string
  generic: string | null
  drug_class: string | null
  common_use: string | null
  dictionary_match: string | null
  dictionary_score: number | null
  strength: string | null
  form: string | null
  dose: string | null
  frequency_raw: string | null
  frequency_code: string | null
  frequency_text: string | null
  morning: number | null
  afternoon: number | null
  night: number | null
  meal_relation: string | null
  route: string | null
  duration_text: string | null
  duration_days: number | null
  instructions: string | null
}

export interface ReviewObservation extends ReviewItem {
  category: string
  panel: string | null
  name_raw: string
  name: string
  loinc: string | null
  value_original: string | null
  unit_original: string | null
  value_num: number | null
  value_text: string | null
  unit: string | null
  ref_low: number | null
  ref_high: number | null
  ref_text: string | null
  ref_source: string | null
  interpretation: Flag
  critical: boolean
  flag_on_report: string | null
}

export interface ReviewCondition extends ReviewItem {
  name_raw: string
  name: string
  icd10: string | null
  icd10_display: string | null
  verification_status: string
}

export interface ReviewPayload {
  document: {
    doc_type: string
    title: string | null
    document_date: string | null
    document_date_raw: string | null
    facility: string | null
    author: string | null
    author_registration: string | null
    patient: { name: string | null; age: string | null; gender: string | null; patient_identifier: string | null; abha_number: string | null }
    findings: string | null
    impression: string | null
    advice: string[]
    follow_up: string | null
    legibility: string | null
    unreadable: string[]
    languages: string[]
    handwritten: boolean
  }
  medications: ReviewMedication[]
  observations: ReviewObservation[]
  conditions: ReviewCondition[]
  encounter: {
    start_date: string | null
    end_date: string | null
    reason: string | null
    hospital_course: string | null
    procedures: string[]
    discharge_condition: string | null
  } | null
  issues: Issue[]
  stats: { items_total: number; needs_review: number; corrected_by_verifier: number; added_by_verifier: number; avg_confidence: number }
}

export interface PipelineLogEntry {
  stage: string
  ms?: number
  model?: string
  tokens?: number
  [k: string]: unknown
}

export interface DocumentInfo {
  id: string
  patient_id: string
  filename: string
  mime_type: string
  source: string
  doc_type: string | null
  status: 'queued' | 'processing' | 'review' | 'confirmed' | 'failed'
  stage: string
  progress: number
  error: string | null
  page_count: number
  page_urls: string[]
  file_url: string
  languages: string[]
  handwritten: boolean
  document_date: string | null
  facility: string | null
  author: string | null
  title: string | null
  created_at: string
  confirmed_at: string | null
  pipeline_log: PipelineLogEntry[]
  stats?: ReviewPayload['stats']
  review?: ReviewPayload | null
  classification?: { document_type: string; languages: string[]; handwritten: boolean; legibility: string; title: string | null; reasoning: string } | null
  verified_extraction?: {
    corrections: { path: string; old_value: string | null; new_value: string | null; reason: string }[]
    items_added: string[]
    items_removed: string[]
    uncertain_fields: string[]
  } | null
}

export interface Observation {
  id: string
  document_id: string | null
  category: string
  name: string
  name_raw: string
  loinc: string | null
  panel: string | null
  value_num: number | null
  value_text: string | null
  unit: string | null
  value_original: string | null
  unit_original: string | null
  ref_low: number | null
  ref_high: number | null
  ref_text: string | null
  ref_source: string | null
  interpretation: Flag
  critical: boolean
  effective_date: string | null
  confidence: number | null
}

export interface Medication {
  id: string
  document_id: string | null
  name: string
  name_raw: string
  generic: string | null
  drug_class: string | null
  strength: string | null
  form: string | null
  dose: string | null
  frequency_raw: string | null
  frequency_code: string | null
  morning: number | null
  afternoon: number | null
  night: number | null
  meal_relation: string | null
  route: string | null
  duration_text: string | null
  duration_days: number | null
  instructions: string | null
  prescriber: string | null
  authored_on: string | null
  status: 'active' | 'completed'
}

export interface Condition {
  id: string
  document_id: string | null
  name: string
  icd10: string | null
  icd10_display: string | null
  verification_status: string
  recorded_date: string | null
}

export interface Profile {
  patient: Patient
  counts: { documents: number; pending_review: number; processing: number; results: number; medications: number; conditions: number }
  critical: Observation[]
  abnormal_latest: Observation[]
  active_medications: Medication[]
  conditions: Condition[]
  latest_vitals: Observation[]
  last_record_date: string | null
}

export interface TimelineEvent {
  id: string
  date: string | null
  date_known: boolean
  type: string
  title: string
  status: DocumentInfo['status']
  source: string
  facility: string | null
  author: string | null
  languages: string[]
  handwritten: boolean
  abnormal_count: number
  critical_count: number
  highlights: { name: string; value: number | string | null; unit: string | null; flag: Flag }[]
  medications: string[]
  conditions: string[]
  encounter: { class: string; start: string | null; end: string | null } | null
}

export interface TrendSeries {
  key: string
  name: string
  loinc: string | null
  unit: string | null
  panel: string | null
  category: string
  mixed_units: boolean
  ref_low: number | null
  ref_high: number | null
  about: string | null
  latest: Observation
  points: { id: string; document_id: string | null; date: string | null; value: number; unit: string | null; flag: Flag; ref_low: number | null; ref_high: number | null }[]
}

export interface Summary {
  headline: string
  overview: string
  key_points: { text: string; record_ids: string[] }[]
  abnormal: {
    record_id: string
    test: string
    what_it_measures: string
    what_this_may_mean: string
    questions_for_doctor: string[]
    value: number | string | null
    unit: string | null
    reference: string | null
    flag: Flag
    critical: boolean
    date: string | null
  }[]
  medications: {
    record_id: string
    name: string
    commonly_used_for: string
    how_to_take: string
    strength: string | null
    morning: number | null
    afternoon: number | null
    night: number | null
    meal_relation: string | null
    duration_days: number | null
    frequency: string | null
    status: string
  }[]
  trends: { text: string; record_ids: string[] }[]
  next_steps: string[]
  questions_for_doctor: string[]
  glossary: { term: string; meaning: string }[]
  language: Lang
  disclaimer: string
  critical_alert: string | null
  critical_results: { id: string; test: string; value: number | string | null; unit: string | null; flag: string | null }[]
  safety: { regenerated: boolean; redacted: boolean; violations: string[]; numbers_preserved: boolean }
  grounded_on: { results: number; medications: number; conditions: number }
}

export interface ChatReply {
  answer: string
  citations: { id: string; kind: string; label: string; date: string | null; document_id: string | null }[]
  results: (Observation & { trend: { date: string; value: number; flag: Flag }[] })[]
  medications: Medication[]
  follow_ups: string[]
  /** ISO code of the language the answer is written in (it follows the user's message, not the app language). */
  reply_language?: string
  understood_question?: string | null
  answered_from_records: boolean
  suggest_doctor: boolean
  emergency_notice: string | null
  safety: { passed: boolean; violations: string[] }
}

export interface Health {
  status: string
  llm_provider: string
  models: Record<string, string>
  verification: boolean
  knowledge: { lab_tests: number; drugs: number; icd10: number }
  languages: Record<Lang, string>
}

export type DoseStatus = 'pending' | 'due' | 'missed' | 'taken' | 'skipped' | 'snoozed'

export interface Dose {
  reminder_id: string
  patient_id: string
  patient_name: string
  language: Lang
  medication_id: string | null
  title: string
  detail: string | null
  amount: string
  slot: 'morning' | 'afternoon' | 'night'
  time: string
  day: string
  status: DoseStatus
  snooze_until: string | null
  acted_at: string | null
}

export interface ReminderSlot {
  time: string
  slot: string
  amount: string
}

export interface Reminder {
  id: string
  patient_id: string
  medication_id: string | null
  title: string
  detail: string | null
  slots: ReminderSlot[]
  weekdays: number[] | null
  start_date: string
  end_date: string | null
  status: 'active' | 'paused' | 'ended'
  source: 'copilot' | 'user'
}

export interface Appointment {
  id: string
  patient_id: string
  patient_name?: string
  kind: 'visit' | 'test'
  title: string
  due_date: string
  time: string | null
  doctor: string | null
  facility: string | null
  notes: string | null
  status: 'upcoming' | 'done' | 'cancelled'
  source: 'copilot' | 'user'
  source_text: string | null
  document_id: string | null
}

export interface Adherence {
  days: number
  scheduled: number
  taken: number
  percent: number | null
}

export interface Evidence {
  id: string
  test: string
  value: number | string | null
  unit: string | null
  date: string | null
  flag: string | null
  document_id: string | null
}

export interface Insight {
  key: string
  kind: 'persistent' | 'trend' | 'combination' | 'improving' | 'range'
  level: 'attention' | 'watch' | 'good'
  title: string
  body: string
  evidence: Evidence[]
  test: string
  next_step: string | null
  question: string | null
}

export interface PreventiveItem {
  key: string
  kind: 'repeat_test' | 'follow_up' | 'screening'
  title: string
  why: string
  status: 'overdue' | 'due_soon' | 'not_done' | 'ok' | 'ask'
  due_date: string | null
  last_date: string | null
  interval_days: number | null
  evidence: Evidence[]
  source: string
  appointment_id?: string
  document_id?: string | null
}

export interface WellnessTip {
  key: string
  category: 'diet' | 'activity' | 'sleep' | 'habits' | 'monitoring'
  title: string
  body: string
  why: string
  evidence: Evidence[]
}

export interface CareOverview {
  insights: Insight[]
  preventive: PreventiveItem[]
  wellness: WellnessTip[]
  adherence: Adherence
  profile: { age: number | null; gender: string | null; conditions: string[] }
  translated: boolean
  language: Lang
  disclaimer: string
}

export interface CopilotAction {
  id: string
  patient_id: string
  kind: 'reminders' | 'reminders_stopped' | 'appointment' | 'test_due' | 'overdue' | 'questions'
  title: string
  detail: string | null
  items: { label: string; detail?: string; ref?: string }[]
  ref_ids: string[]
  document_id: string | null
  status: 'done' | 'proposed' | 'kept' | 'accepted' | 'rejected' | 'resolved' | 'superseded'
  created_at: string
}

export interface VisitPrep {
  patient: { name: string; age: number | null; gender: string | null; conditions: string[] }
  questions: string[]
  questions_action_id: string | null
  medications: { id: string; name: string; strength?: string; schedule?: string; meal?: string; status?: string }[]
  insights: Insight[]
  due: PreventiveItem[]
  adherence: Adherence
  generated_on: string
  disclaimer: string
}
