import type {
  Account,
  Adherence,
  Appointment,
  CareOverview,
  CopilotAction,
  Dose,
  Reminder,
  ReminderSlot,
  VisitPrep,
  CodeSent,
  ChatReply,
  DocumentInfo,
  Health,
  Lang,
  Medication,
  Observation,
  Patient,
  Profile,
  ReviewPayload,
  Summary,
  TimelineEvent,
  TrendSeries,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Fired when the session has expired or was revoked, so the app can return to the sign-in screen. */
export const UNAUTHORIZED_EVENT = 'hc:unauthorized'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json()
      msg = errorText(body.detail ?? body)
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

/** FastAPI validation errors arrive as a list of {loc, msg}; show just the messages. */
function errorText(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail))
    return detail
      .map((d) => String((d as { msg?: string }).msg ?? d).replace(/^Value error, /, ''))
      .join('. ')
  return JSON.stringify(detail)
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  health: () => request<Health>('/api/health'),
  me: () => request<Account>('/api/auth/me'),
  registerStart: (body: { first_name: string; last_name: string; email: string; password: string; phone?: string }) =>
    request<CodeSent>('/api/auth/register/start', json('POST', body)),
  registerVerify: (body: { email: string; code: string }) => request<Account>('/api/auth/register/verify', json('POST', body)),
  forgotPassword: (login: string) => request<CodeSent>('/api/auth/forgot', json('POST', { login })),
  resetPassword: (body: { login: string; code: string; password: string }) => request<Account>('/api/auth/reset', json('POST', body)),
  emailStart: (body: { email: string; current_password?: string }) => request<CodeSent>('/api/auth/email/start', json('POST', body)),
  emailVerify: (code: string) => request<Account>('/api/auth/email/verify', json('POST', { code })),
  login: (body: { login: string; password: string }) => request<Account>('/api/auth/login', json('POST', body)),
  logout: () => request<{ signed_out: boolean }>('/api/auth/logout', json('POST')),
  updateMe: (body: {
    name?: string
    login?: string
    /** "" removes the number. */
    phone?: string
    current_password?: string
    notify_security?: boolean
    notify_medicines?: boolean
    notify_weekly?: boolean
  }) => request<Account>('/api/auth/me', json('PATCH', body)),
  changePassword: (body: { current_password: string; new_password: string }) =>
    request<{ changed: boolean }>('/api/auth/password', json('POST', body)),
  deleteAccount: (password: string) => request<{ deleted: boolean }>('/api/auth/delete-account', json('POST', { password })),
  patients: () => request<Patient[]>('/api/patients'),
  createPatient: (body: Partial<Patient>) => request<Patient>('/api/patients', json('POST', body)),
  updatePatient: (id: string, body: Partial<Patient>) => request<Patient>(`/api/patients/${id}`, json('PATCH', body)),
  deletePatient: (id: string) => request<{ deleted: boolean }>(`/api/patients/${id}`, json('DELETE')),
  profile: (id: string) => request<Profile>(`/api/patients/${id}/profile`),
  timeline: (id: string) => request<TimelineEvent[]>(`/api/patients/${id}/timeline`),
  trends: (id: string) => request<TrendSeries[]>(`/api/patients/${id}/trends`),
  medications: (id: string) => request<Medication[]>(`/api/patients/${id}/medications`),
  observations: (id: string) => request<Observation[]>(`/api/patients/${id}/observations`),
  documents: (id: string) => request<DocumentInfo[]>(`/api/patients/${id}/documents`),
  upload: (id: string, files: File[]) => {
    const fd = new FormData()
    files.forEach((f) => fd.append('files', f))
    return request<DocumentInfo[]>(`/api/patients/${id}/documents`, { method: 'POST', body: fd })
  },
  document: (docId: string) => request<DocumentInfo>(`/api/documents/${docId}`),
  refreshReview: (docId: string, payload: ReviewPayload) =>
    request<ReviewPayload>(`/api/documents/${docId}/review/refresh`, json('POST', payload)),
  confirm: (docId: string, payload: ReviewPayload) =>
    request<{ document: DocumentInfo; saved: Record<string, number>; copilot?: { id: string; kind: string; title: string }[] }>(`/api/documents/${docId}/confirm`, json('POST', payload)),
  reprocess: (docId: string) => request<DocumentInfo>(`/api/documents/${docId}/reprocess`, json('POST')),
  deleteDocument: (docId: string) => request<{ deleted: boolean }>(`/api/documents/${docId}`, json('DELETE')),
  documentFhir: (docId: string) => request<{ bundle: Record<string, unknown>; validation_errors: string[] }>(`/api/documents/${docId}/fhir`),
  documentSummary: (docId: string, lang: Lang) => request<Summary>(`/api/documents/${docId}/summary?lang=${lang}`),
  patientSummary: (id: string, lang: Lang) => request<Summary>(`/api/patients/${id}/summary?lang=${lang}`),
  chat: (id: string, message: string, history: { role: string; content: string }[], lang: Lang, voice = false) =>
    request<ChatReply>(`/api/patients/${id}/chat`, json('POST', { message, history, lang, voice })),
  abhaInit: (id: string, body: { abha_number?: string; abha_address?: string }) =>
    request<{ txn_id: string; message: string; demo_otp_hint: string }>(`/api/patients/${id}/abha/init`, json('POST', body)),
  abhaConfirm: (id: string, txn_id: string, otp: string) =>
    request<{ linked: boolean; abha_number: string; abha_address: string }>(`/api/patients/${id}/abha/confirm`, json('POST', { txn_id, otp })),
  abhaImport: (id: string, hi_types: string[]) =>
    request<{
      consent: Record<string, unknown> & { consent_id: string; hi_types: string[]; permission: { date_range: { from: string; to: string } } }
      imported: { id: string; title: string; type: string; date: string | null }[]
      fhir_validation_errors: string[]
      bundles: number
    }>(`/api/patients/${id}/abha/import`, json('POST', { hi_types })),
  abhaUnlink: (id: string) => request<{ linked: boolean }>(`/api/patients/${id}/abha`, json('DELETE')),
  fhirExportUrl: (id: string) => `/api/patients/${id}/fhir`,

  today: (day?: string) => request<{ day: string; now: string; doses: Dose[]; appointments: Appointment[] }>(`/api/today${day ? `?day=${day}` : ''}`),
  dueDoses: () => request<Dose[]>('/api/reminders/due'),
  dose: (reminderId: string, body: { day: string; time: string; action: 'taken' | 'skipped' | 'snoozed' | 'undo'; minutes?: number }) =>
    request<{ status: string; snooze_until: string | null }>(`/api/reminders/${reminderId}/doses`, json('POST', body)),
  reminders: (id: string) => request<{ reminders: Reminder[]; appointments: Appointment[]; adherence: Adherence }>(`/api/patients/${id}/reminders`),
  createReminder: (id: string, body: { title: string; detail?: string; slots: Pick<ReminderSlot, 'time' | 'amount'>[]; end_date?: string | null }) =>
    request<Reminder>(`/api/patients/${id}/reminders`, json('POST', body)),
  updateReminder: (
    rid: string,
    body: { title?: string; detail?: string; slots?: Pick<ReminderSlot, 'time' | 'amount'>[]; end_date?: string; clear_end_date?: boolean; status?: 'active' | 'paused' | 'ended' },
  ) => request<Reminder>(`/api/reminders/${rid}`, json('PATCH', body)),
  deleteReminder: (rid: string) => request<{ deleted: boolean }>(`/api/reminders/${rid}`, json('DELETE')),
  createAppointment: (id: string, body: Partial<Appointment> & { title: string; due_date: string }) =>
    request<Appointment>(`/api/patients/${id}/appointments`, json('POST', body)),
  updateAppointment: (aid: string, body: Partial<Appointment>) => request<Appointment>(`/api/appointments/${aid}`, json('PATCH', body)),
  care: (id: string, lang: Lang) => request<CareOverview>(`/api/patients/${id}/care?lang=${lang}`),
  copilot: (id: string, lang: Lang) => request<CopilotAction[]>(`/api/patients/${id}/copilot?lang=${lang}`),
  decide: (aid: string, decision: 'keep' | 'undo' | 'accept' | 'dismiss' | 'edit', items?: { label: string }[]) =>
    request<CopilotAction>(`/api/copilot/${aid}`, json('POST', { decision, items })),
  visitPrep: (id: string, lang: Lang) => request<VisitPrep>(`/api/patients/${id}/visit-prep?lang=${lang}`),
  pushKey: () => request<{ public_key: string }>('/api/push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<{ subscribed: boolean }>('/api/push/subscribe', json('POST', sub)),
  pushUnsubscribe: (endpoint: string) => request<{ subscribed: boolean }>('/api/push/unsubscribe', json('POST', { endpoint })),
  pushTest: () => request<{ sent: number }>('/api/push/test', json('POST')),
}
