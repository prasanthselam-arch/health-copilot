import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ClipboardList, FileText, FlaskConical, Hospital, Pill, Plus, RefreshCw, ShieldCheck, Stethoscope, Trash2 } from 'lucide-react'
import { useMemo, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfidenceBadge, FlagBadge, IssueList, MedSchedule, PipelineSteps, StageLabel, VerifiedBadge } from '@/components/medical'
import { PageViewer } from '@/components/PageViewer'
import { Badge, Button, Card, CardHeader, ErrorNote, Input, Label, Select, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient } from '@/lib/patient'
import type { ReviewCondition, ReviewItem, ReviewMedication, ReviewObservation, ReviewPayload } from '@/lib/types'
import { cn } from '@/lib/utils'

type ListKey = 'medications' | 'observations' | 'conditions'
type ItemOf<K extends ListKey> = ReviewPayload[K][number]

const DOC_TYPES = ['prescription', 'lab_report', 'discharge_summary', 'imaging_report', 'other']
const MEALS = ['before_food', 'after_food', 'with_food', 'empty_stomach', 'bedtime']
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const base = (): ReviewItem => ({ id: newId(), confidence: 1, needs_review: false, verified: 'single_pass', page: null, issues: [] })
/** A plain number: "4.5", "4,5" (decimal comma), "1,50,000" or "150,000" (thousands). Anything else is text. */
const num = (s: string): number | null => {
  const v = s.trim()
  const n = /^[-+]?\d{1,3}(,\d{2,3})*,\d{3}(\.\d+)?$/.test(v)
    ? Number(v.replace(/,/g, ''))
    : /^[-+]?(\d+[.,]?\d*|[.,]\d+)$/.test(v)
      ? Number(v.replace(',', '.'))
      : NaN
  return Number.isNaN(n) ? null : n
}
const small = 'h-8 px-2 py-1'

/** Keeps the typed text so partial numbers such as "0." survive until they are complete. */
function DecimalInput({ value, onValue, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | null; onValue: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (num(text) !== value) setText(value === null ? '' : String(value))
  }
  return (
    <Input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onValue(num(e.target.value))
      }}
      {...props}
    />
  )
}

/** A result value: numeric when it parses as a number, otherwise kept as text ("Positive", "<0.5"). */
function ValueInput({
  valueNum,
  valueText,
  onValue,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  valueNum: number | null
  valueText: string | null
  onValue: (v: { value_num: number | null; value_text: string | null }) => void
}) {
  const shown = valueText ?? (valueNum !== null ? String(valueNum) : '')
  const [text, setText] = useState(shown)
  const [seen, setSeen] = useState(shown)
  if (shown !== seen) {
    setSeen(shown)
    const n = num(text)
    if (n !== null ? n !== valueNum || valueText !== null : (text || null) !== valueText) setText(shown)
  }
  return (
    <Input
      value={text}
      onChange={(e) => {
        const v = e.target.value
        const n = num(v)
        setText(v)
        onValue(n !== null ? { value_num: n, value_text: null } : { value_num: null, value_text: v || null })
      }}
      {...props}
    />
  )
}

export default function Review() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const patient = useActivePatient()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [local, setLocal] = useState<ReviewPayload | null>(null)
  const [dirty, setDirty] = useState(false)
  const [edited, setEdited] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: () => api.document(id),
    refetchInterval: (q) => (q.state.data && ['queued', 'processing'].includes(q.state.data.status) ? 1500 : false),
  })

  const draft = local ?? doc.data?.review ?? null
  const setDraft = (u: ReviewPayload | ((d: ReviewPayload | null) => ReviewPayload | null)) =>
    setLocal((prev) => (typeof u === 'function' ? u(prev ?? doc.data?.review ?? null) : u))

  const refresh = useMutation({
    mutationFn: (p: ReviewPayload) => api.refreshReview(id, p),
    onSuccess: (p) => {
      setDraft(p)
      setDirty(false)
    },
  })

  const confirm = useMutation({
    mutationFn: (p: ReviewPayload) => api.confirm(id, p),
    onSuccess: async (res) => {
      await Promise.all(
        [['document', id], ['documents', patient.id], ['profile', patient.id], ['timeline', patient.id], ['trends', patient.id], ['medications', patient.id]].map(
          (k) => qc.invalidateQueries({ queryKey: k }),
        ),
      )
      for (const k of [['patientSummary', patient.id], ['docSummary', id], ['docFhir', id], ['copilot'], ['today'], ['care'], ['reminders']])
        qc.removeQueries({ queryKey: k })
      nav(`/documents/${id}`, { state: { copilot: res.copilot ?? [] } })
    },
  })
  const retry = useMutation({
    mutationFn: () => api.reprocess(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['document', id] }),
  })
  const del = useMutation({
    mutationFn: () => api.deleteDocument(id),
    onSuccess: async () => {
      nav('/upload', { replace: true })
      qc.removeQueries({ queryKey: ['document', id] })
      qc.removeQueries({ queryKey: ['patientSummary', patient.id] })
      await Promise.all(
        [['documents', patient.id], ['profile', patient.id], ['timeline', patient.id], ['trends', patient.id], ['medications', patient.id]].map((k) =>
          qc.invalidateQueries({ queryKey: k }),
        ),
      )
    },
  })
  const deleteButton = (saved: boolean) => (
    <Button
      variant="danger"
      size="sm"
      loading={del.isPending}
      onClick={() => window.confirm(t(saved ? 'docview.delete_confirm' : 'upload.delete_confirm')) && del.mutate()}
    >
      <Trash2 className="h-4 w-4" />
      {t('common.delete')}
    </Button>
  )

  const update = <K extends ListKey>(key: K, itemId: string, changes: Partial<ItemOf<K>>, markDirty = true) => {
    setDraft((d) => (d ? { ...d, [key]: (d[key] as ItemOf<K>[]).map((it) => (it.id === itemId ? { ...it, ...changes, needs_review: false } : it)) } : d))
    if (markDirty) {
      setDirty(true)
      setEdited((s) => new Set(s).add(itemId))
    }
  }
  const remove = (key: ListKey, itemId: string) => {
    setDraft((d) => (d ? { ...d, [key]: (d[key] as ReviewItem[]).filter((it) => it.id !== itemId) } : d))
    setDirty(true)
  }
  const add = <K extends ListKey>(key: K, item: ItemOf<K>) => {
    setDraft((d) => (d ? { ...d, [key]: [...(d[key] as ItemOf<K>[]), item] } : d))
    setEdited((s) => new Set(s).add(item.id))
    setDirty(true)
  }
  const setDoc = (changes: Partial<ReviewPayload['document']>) => {
    setDraft((d) => (d ? { ...d, document: { ...d.document, ...changes } } : d))
  }

  const pending = useMemo(
    () => (draft ? [...draft.medications, ...draft.observations, ...draft.conditions].filter((i) => i.needs_review).length : 0),
    [draft],
  )

  if (doc.isLoading) return <Spinner label={t('common.loading')} />
  if (doc.error) return <ErrorNote error={doc.error} onRetry={() => doc.refetch()} />
  const d = doc.data!

  if (d.status === 'queued' || d.status === 'processing' || d.status === 'failed') {
    return (
      <Card className="mx-auto max-w-xl p-6">
        <p className="font-medium text-slate-900">{d.filename}</p>
        <div className="mt-4">
          <PipelineSteps stage={d.stage} status={d.status} />
        </div>
        <div className="mt-3">
          <StageLabel stage={d.stage} status={d.status} />
        </div>
        {d.error && <p className="mt-3 text-sm text-red-600">{d.error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {d.status === 'failed' && d.source === 'upload' && (
            <Button variant="secondary" size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
              <RefreshCw className="h-4 w-4" />
              {t('upload.retry_btn')}
            </Button>
          )}
          {deleteButton(false)}
        </div>
        {(retry.error || del.error) && <div className="mt-3"><ErrorNote error={retry.error ?? del.error} /></div>}
      </Card>
    )
  }
  if (!draft) return <Spinner />

  const ver = d.verified_extraction
  const pageLink = (p: number | null) =>
    p ? (
      <button onClick={() => setPage(p)} className="text-xs text-brand-700 hover:underline">
        {t('common.page')} {p}
      </button>
    ) : null
  const meta = (it: ReviewItem) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <ConfidenceBadge value={it.confidence} />
      <VerifiedBadge value={it.verified} />
      {edited.has(it.id) && <Badge className="bg-sky-50 text-sky-700 ring-sky-200">{t('review.edited')}</Badge>}
      {pageLink(it.page)}
    </div>
  )
  const actions = (key: ListKey, it: ReviewItem) => (
    <div className="flex items-center gap-1">
      {it.needs_review && (
        <Button size="sm" variant="secondary" onClick={() => update(key, it.id, {}, false)}>
          <Check className="h-3.5 w-3.5" />
          {t('review.accept')}
        </Button>
      )}
      <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-red-600" title={t('common.remove')} onClick={() => remove(key, it.id)}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/upload" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-4 w-4" />
            {t('common.back')}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('review.title')}</h1>
          <p className="mt-1 text-slate-500">{t('review.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="h-8 px-3 text-sm">{t('review.items', { count: draft.stats.items_total })}</Badge>
          {pending > 0 ? (
            <Badge className="h-8 bg-amber-50 px-3 text-sm text-amber-800 ring-amber-200">{t('review.needs_review', { count: pending })}</Badge>
          ) : (
            <Badge className="h-8 bg-emerald-50 px-3 text-sm text-emerald-700 ring-emerald-200">
              <Check className="h-3.5 w-3.5" />
              {t('review.all_reviewed')}
            </Badge>
          )}
          <Badge className="h-8 px-3 text-sm">
            {t('review.avg_conf')} {Math.round(draft.stats.avg_confidence * 100)}%
          </Badge>
          {deleteButton(d.status === 'confirmed')}
        </div>
      </div>
      {del.error && <ErrorNote error={del.error} />}

      {d.status === 'confirmed' && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <ShieldCheck className="h-4 w-4" />
          {t('review.confirmed_msg')}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-7rem)]">
          <div className="h-[55svh] sm:h-[60vh] lg:h-full">
            <PageViewer pages={d.page_urls} fileUrl={d.file_url} page={page} onPage={setPage} />
          </div>
        </div>

        <div className="space-y-5">
          {draft.issues.length > 0 && (
            <Card className="p-4">
              <IssueList issues={draft.issues} className="space-y-1 [&_li]:text-sm" />
            </Card>
          )}

          <Card>
            <CardHeader icon={<FileText className="h-5 w-5" />} title={t('review.doc_info')} />
            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
              <label>
                <Label>{t('review.doc_type')}</Label>
                <Select value={draft.document.doc_type} onChange={(e) => setDoc({ doc_type: e.target.value })}>
                  {DOC_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`doctype.${x}`)}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <Label hint={draft.document.document_date_raw ? `${t('review.as_written')}: ${draft.document.document_date_raw}` : undefined}>{t('review.date')}</Label>
                <Input type="date" value={draft.document.document_date ?? ''} onChange={(e) => setDoc({ document_date: e.target.value || null })} />
              </label>
              <label>
                <Label>{t('review.facility')}</Label>
                <Input value={draft.document.facility ?? ''} onChange={(e) => setDoc({ facility: e.target.value || null })} />
              </label>
              <label>
                <Label>{t('review.doctor')}</Label>
                <Input value={draft.document.author ?? ''} onChange={(e) => setDoc({ author: e.target.value || null })} />
              </label>
              <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
                {draft.document.languages.length > 0 && (
                  <Badge>
                    {t('review.languages')}: {draft.document.languages.join(', ').toUpperCase()}
                  </Badge>
                )}
                {draft.document.handwritten && <Badge>{t('review.handwritten')}</Badge>}
                {draft.document.legibility && <Badge>{draft.document.legibility}</Badge>}
                {d.classification?.reasoning && <span className="text-xs text-slate-500">{d.classification.reasoning}</span>}
              </div>
              {draft.document.unreadable.length > 0 && (
                <p className="text-sm text-amber-700 sm:col-span-2">
                  {t('review.unreadable')}: {draft.document.unreadable.join('; ')}
                </p>
              )}
            </div>
          </Card>

          {ver && (ver.corrections.length > 0 || ver.items_added.length > 0) && (
            <Card>
              <CardHeader icon={<RefreshCw className="h-5 w-5" />} title={t('review.verifier_changes')} />
              <ul className="space-y-1.5 px-5 py-4 text-sm">
                {ver.corrections.map((c, i) => (
                  <li key={i} className="text-slate-700">
                    <span className="font-mono text-xs text-slate-400">{c.path}</span>{' '}
                    <span className="text-red-600 line-through">{c.old_value ?? '∅'}</span> → <span className="font-medium text-emerald-700">{c.new_value ?? '∅'}</span>
                    <span className="text-slate-500"> · {c.reason}</span>
                  </li>
                ))}
                {ver.items_added.map((a, i) => (
                  <li key={`a${i}`} className="text-sky-700">+ {a}</li>
                ))}
              </ul>
            </Card>
          )}

          <Section
            icon={<Pill className="h-5 w-5" />}
            title={t('review.medicines')}
            count={draft.medications.length}
            onAdd={() => add('medications', { ...base(), name_raw: '', name: '', generic: null, drug_class: null, common_use: null, dictionary_match: null, dictionary_score: null, strength: null, form: null, dose: null, frequency_raw: null, frequency_code: null, frequency_text: null, morning: null, afternoon: null, night: null, meal_relation: null, route: null, duration_text: null, duration_days: null, instructions: null } satisfies ReviewMedication)}
            addLabel={t('review.add_med')}
          >
            {draft.medications.map((m) => (
              <ItemShell key={m.id} flagged={m.needs_review}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[2fr_1fr]">
                    <Input className="font-medium" placeholder={t('review.name')} value={m.name} onChange={(e) => update('medications', m.id, { name: e.target.value, generic: null })} />
                    <Input placeholder={t('review.strength')} value={m.strength ?? ''} onChange={(e) => update('medications', m.id, { strength: e.target.value || null })} />
                  </div>
                  {actions('medications', m)}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {m.name_raw && (
                    <>
                      {t('review.as_written')}: <span className="font-medium text-slate-700">“{m.name_raw}”</span>
                    </>
                  )}
                  {m.generic && (
                    <>
                      {' · '}
                      {t('review.generic')}: <span className="text-slate-700">{m.generic}</span>
                    </>
                  )}
                  {m.drug_class && ` · ${m.drug_class}`}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <label className="sm:col-span-1">
                    <span className="text-xs text-slate-500">{t('review.frequency')}</span>
                    <Input className={small} value={m.frequency_raw ?? ''} placeholder="1-0-1 / BD" onChange={(e) => update('medications', m.id, { frequency_raw: e.target.value || null })} />
                  </label>
                  <label>
                    <span className="text-xs text-slate-500">{t('review.meal')}</span>
                    <Select className={small} value={m.meal_relation ?? ''} onChange={(e) => update('medications', m.id, { meal_relation: e.target.value || null })}>
                      <option value="">—</option>
                      {MEALS.map((x) => (
                        <option key={x} value={x}>
                          {t(`schedule.${x}`)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    <span className="text-xs text-slate-500">{t('review.duration')}</span>
                    <Input className={small} value={m.duration_text ?? ''} placeholder={t('review.duration_hint')} onChange={(e) => update('medications', m.id, { duration_text: e.target.value || null, duration_days: null })} />
                  </label>
                  <label>
                    <span className="text-xs text-slate-500">{t('review.dose')}</span>
                    <Input className={small} value={m.dose ?? ''} onChange={(e) => update('medications', m.id, { dose: e.target.value || null })} />
                  </label>
                  <label className="sm:col-span-4">
                    <span className="text-xs text-slate-500">{t('review.instructions')}</span>
                    <Input className={small} value={m.instructions ?? ''} onChange={(e) => update('medications', m.id, { instructions: e.target.value || null })} />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <MedSchedule morning={m.morning} afternoon={m.afternoon} night={m.night} meal={null} days={m.duration_days} />
                  {meta(m)}
                </div>
                <IssueList issues={m.issues} className="mt-2" />
              </ItemShell>
            ))}
          </Section>

          <Section
            icon={<FlaskConical className="h-5 w-5" />}
            title={t('review.results')}
            count={draft.observations.length}
            onAdd={() => add('observations', { ...base(), category: 'laboratory', panel: null, name_raw: '', name: '', loinc: null, value_original: null, unit_original: null, value_num: null, value_text: null, unit: null, ref_low: null, ref_high: null, ref_text: null, ref_source: null, interpretation: null, critical: false, flag_on_report: null } satisfies ReviewObservation)}
            addLabel={t('review.add_result')}
          >
            {draft.observations.map((o) => (
              <ItemShell key={o.id} flagged={o.needs_review} critical={o.critical}>
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]">
                  <div className="min-w-0">
                    <Input className={cn(small, 'font-medium')} placeholder={t('review.test')} value={o.name} onChange={(e) => update('observations', o.id, { name: e.target.value, loinc: null })} />
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {o.panel && `${o.panel} · `}
                      {o.loinc && <span className="font-mono">LOINC {o.loinc}</span>}
                    </p>
                  </div>
                  <div>
                    <ValueInput
                      className={cn(small, 'font-semibold')}
                      placeholder={t('review.value')}
                      aria-label={t('review.value')}
                      valueNum={o.value_num}
                      valueText={o.value_text}
                      onValue={(v) => update('observations', o.id, v)}
                    />
                    {o.value_original && o.value_original !== String(o.value_num) && <p className="mt-1 truncate text-xs text-slate-500">“{o.value_original}”</p>}
                  </div>
                  <div>
                    <Input className={small} placeholder={t('review.unit')} value={o.unit ?? ''} onChange={(e) => update('observations', o.id, { unit: e.target.value || null })} />
                    {o.unit_original && o.unit_original !== o.unit && <p className="mt-1 truncate text-xs text-slate-500">“{o.unit_original}”</p>}
                  </div>
                  <div>
                    <div className="flex items-center gap-1">
                      <DecimalInput className={small} placeholder={t('review.range_low')} aria-label={t('review.range_low')} value={o.ref_low} onValue={(v) => update('observations', o.id, { ref_low: v, ref_source: 'report' })} />
                      <span className="text-slate-400">–</span>
                      <DecimalInput className={small} placeholder={t('review.range_high')} aria-label={t('review.range_high')} value={o.ref_high} onValue={(v) => update('observations', o.id, { ref_high: v, ref_source: 'report' })} />
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{o.ref_source === 'curated' ? t('review.range_curated') : o.ref_text || (o.ref_source ? t('review.range_report') : '')}</p>
                  </div>
                  <div className="flex items-start justify-end gap-1">
                    <FlagBadge flag={o.interpretation} className="mt-1.5" />
                    {actions('observations', o)}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <IssueList issues={o.issues} />
                  {meta(o)}
                </div>
              </ItemShell>
            ))}
          </Section>

          <Section
            icon={<Stethoscope className="h-5 w-5" />}
            title={t('review.diagnoses')}
            count={draft.conditions.length}
            onAdd={() => add('conditions', { ...base(), name_raw: '', name: '', icd10: null, icd10_display: null, verification_status: 'confirmed' } satisfies ReviewCondition)}
            addLabel={t('review.add_diagnosis')}
          >
            {draft.conditions.map((c) => (
              <ItemShell key={c.id} flagged={c.needs_review}>
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <Input className={cn(small, 'font-medium')} value={c.name} placeholder={t('review.name')} onChange={(e) => update('conditions', c.id, { name: e.target.value, icd10: null, icd10_display: null })} />
                    {c.name_raw && c.name_raw !== c.name && <p className="mt-1 truncate text-xs text-slate-500">“{c.name_raw}”</p>}
                  </div>
                  <div>
                    <Input className={cn(small, 'font-mono')} value={c.icd10 ?? ''} placeholder="ICD-10" onChange={(e) => update('conditions', c.id, { icd10: e.target.value.toUpperCase() || null })} />
                    {c.icd10_display && <p className="mt-1 truncate text-xs text-slate-500">{c.icd10_display}</p>}
                  </div>
                  <Select className={small} value={c.verification_status} onChange={(e) => update('conditions', c.id, { verification_status: e.target.value })}>
                    <option value="confirmed">{t('review.status_confirmed')}</option>
                    <option value="provisional">{t('review.status_provisional')}</option>
                  </Select>
                  {actions('conditions', c)}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <IssueList issues={c.issues} />
                  {meta(c)}
                </div>
              </ItemShell>
            ))}
          </Section>

          {draft.encounter && (
            <Card>
              <CardHeader icon={<Hospital className="h-5 w-5" />} title={t('review.hospital_stay')} />
              <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                <label>
                  <Label>{t('review.admitted')}</Label>
                  <Input type="date" value={draft.encounter.start_date ?? ''} onChange={(e) => setDraft({ ...draft, encounter: { ...draft.encounter!, start_date: e.target.value || null } })} />
                </label>
                <label>
                  <Label>{t('review.discharged')}</Label>
                  <Input type="date" value={draft.encounter.end_date ?? ''} onChange={(e) => setDraft({ ...draft, encounter: { ...draft.encounter!, end_date: e.target.value || null } })} />
                </label>
                <label className="sm:col-span-2">
                  <Label>{t('review.reason')}</Label>
                  <Input value={draft.encounter.reason ?? ''} onChange={(e) => setDraft({ ...draft, encounter: { ...draft.encounter!, reason: e.target.value || null } })} />
                </label>
                {draft.encounter.hospital_course && (
                  <div className="sm:col-span-2">
                    <Label>{t('review.course')}</Label>
                    <p className="text-sm leading-relaxed text-slate-700">{draft.encounter.hospital_course}</p>
                  </div>
                )}
              </div>
            </Card>
          )}

          {(draft.document.findings || draft.document.impression || draft.document.advice.length > 0 || draft.document.follow_up) && (
            <Card>
              <CardHeader icon={<ClipboardList className="h-5 w-5" />} title={t('review.advice')} />
              <div className="space-y-3 p-5 text-sm text-slate-700">
                {draft.document.findings && (
                  <p>
                    <span className="font-medium text-slate-900">{t('review.findings')}: </span>
                    {draft.document.findings}
                  </p>
                )}
                {draft.document.impression && (
                  <p>
                    <span className="font-medium text-slate-900">{t('review.impression')}: </span>
                    {draft.document.impression}
                  </p>
                )}
                {draft.document.advice.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5">
                    {draft.document.advice.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
                {draft.document.follow_up && (
                  <p>
                    <span className="font-medium text-slate-900">{t('review.follow_up')}: </span>
                    {draft.document.follow_up}
                  </p>
                )}
              </div>
            </Card>
          )}

          <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/95 p-3 shadow-lg ring-1 ring-slate-200 backdrop-blur lg:bottom-3">
            <p className={cn('text-sm', dirty ? 'text-amber-700' : 'text-slate-500')}>
              {dirty ? t('review.dirty') : pending > 0 ? t('review.needs_review', { count: pending }) : t('review.all_reviewed')}
            </p>
            <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:w-auto">
              <Button variant="secondary" onClick={() => refresh.mutate(draft)} loading={refresh.isPending}>
                <RefreshCw className="h-4 w-4" />
                {t('review.recheck')}
              </Button>
              <Button onClick={() => confirm.mutate(draft)} loading={confirm.isPending}>
                <ShieldCheck className="h-4 w-4" />
                {confirm.isPending ? t('review.confirming') : t('review.confirm_btn')}
              </Button>
            </div>
            {(refresh.error || confirm.error) && <ErrorNote error={refresh.error ?? confirm.error} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ icon, title, count, children, onAdd, addLabel }: { icon: ReactNode; title: string; count: number; children: ReactNode; onAdd: () => void; addLabel: string }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader
        icon={icon}
        title={
          <>
            {title} <span className="ml-1 text-sm font-normal text-slate-400">{count}</span>
          </>
        }
        action={
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            {addLabel}
          </Button>
        }
      />
      {count === 0 ? <p className="px-5 py-5 text-sm text-slate-500">{t('review.nothing')}</p> : <div className="divide-y divide-slate-100">{children}</div>}
    </Card>
  )
}

function ItemShell({ flagged, critical, children }: { flagged: boolean; critical?: boolean; children: ReactNode }) {
  return <div className={cn('border-l-4 px-4 py-3.5', critical ? 'border-red-400 bg-red-50/30' : flagged ? 'border-amber-400 bg-amber-50/30' : 'border-transparent')}>{children}</div>
}
