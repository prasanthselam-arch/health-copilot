import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, FileJson, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FhirBundleView } from '@/components/FhirBundleView'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { CopilotDidBanner } from '@/components/care'
import { FlagBadge, MedSchedule } from '@/components/medical'
import { PageViewer } from '@/components/PageViewer'
import { SummaryView } from '@/components/SummaryView'
import { Badge, Button, Card, CardHeader, ErrorNote, Spinner, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { DocumentInfo } from '@/lib/types'
import { fmtDate, fmtNum, rangeText } from '@/lib/utils'

type Tab = 'summary' | 'original' | 'structured' | 'fhir'

export default function DocumentView() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const qc = useQueryClient()
  const nav = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState<Tab>('summary')

  const doc = useQuery({ queryKey: ['document', id], queryFn: () => api.document(id) })
  const confirmed = doc.data?.status === 'confirmed'
  const summary = useQuery({
    queryKey: ['docSummary', id, lang],
    queryFn: () => api.documentSummary(id, lang),
    enabled: confirmed && tab === 'summary',
    staleTime: 10 * 60_000,
  })
  const fhir = useQuery({ queryKey: ['docFhir', id], queryFn: () => api.documentFhir(id), enabled: confirmed && tab === 'fhir' })

  const invalidate = () =>
    Promise.all([['documents', patient.id], ['profile', patient.id], ['timeline', patient.id], ['trends', patient.id], ['medications', patient.id]].map((k) => qc.invalidateQueries({ queryKey: k })))
  const del = useMutation({
    mutationFn: () => api.deleteDocument(id),
    onSuccess: async () => {
      await invalidate()
      qc.removeQueries({ queryKey: ['patientSummary', patient.id] })
      nav('/timeline')
    },
  })
  const reprocess = useMutation({
    mutationFn: () => api.reprocess(id),
    onSuccess: async () => {
      await invalidate()
      for (const k of [['document', id], ['docSummary', id], ['docFhir', id]]) qc.removeQueries({ queryKey: k })
      nav('/upload')
    },
  })

  if (doc.isLoading) return <Spinner label={t('common.loading')} />
  if (doc.error) return <ErrorNote error={doc.error} onRetry={() => doc.refetch()} />
  const d = doc.data!
  if (!confirmed) return <Navigate to={`/documents/${id}/review`} replace />
  const justDid = (location.state as { copilot?: { id: string; kind: string; title: string }[] } | null)?.copilot ?? []

  const tabs: { value: Tab; label: string }[] = [
    { value: 'summary', label: t('docview.summary') },
    { value: 'original', label: t('docview.original') },
    { value: 'structured', label: t('docview.structured') },
    { value: 'fhir', label: t('docview.fhir') },
  ]

  return (
    <div className="space-y-5">
      <div>
        <Link to="/timeline" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" />
          {t('nav.timeline')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{d.title || d.filename}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
              {d.doc_type && <Badge>{t(`doctype.${d.doc_type}`)}</Badge>}
              {d.source !== 'upload' && <Badge className="bg-brand-50 text-brand-700 ring-brand-200">{t('timeline.imported')}</Badge>}
              {d.handwritten && <Badge>{t('review.handwritten')}</Badge>}
              <span>{d.document_date ? fmtDate(d.document_date, lang) : t('timeline.date_unknown')}</span>
            </div>
            {(d.facility || d.author) && <p className="mt-1 text-sm text-slate-500">{[d.facility, d.author].filter(Boolean).join(' · ')}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to={`/documents/${id}/review`}>
              <Button variant="secondary" size="sm">
                <Pencil className="h-4 w-4" />
                {t('common.edit')}
              </Button>
            </Link>
            {d.source === 'upload' && (
              <Button variant="secondary" size="sm" loading={reprocess.isPending} onClick={() => reprocess.mutate()}>
                <RotateCcw className="h-4 w-4" />
                {t('docview.reprocess')}
              </Button>
            )}
            <Button variant="danger" size="sm" loading={del.isPending} onClick={() => confirm(t('docview.delete_confirm')) && del.mutate()}>
              <Trash2 className="h-4 w-4" />
              {t('common.delete')}
            </Button>
          </div>
        </div>
      </div>

      <CopilotDidBanner actions={justDid} />

      <Tabs value={tab} onChange={setTab} items={tabs} />

      {tab === 'summary' && (
        <Card className="p-5 sm:p-6">
          {summary.isLoading ? (
            <Spinner label={t('dashboard.summary_loading')} />
          ) : summary.error ? (
            <ErrorNote error={summary.error} onRetry={() => summary.refetch()} />
          ) : summary.data ? (
            <SummaryView s={summary.data} />
          ) : null}
        </Card>
      )}

      {tab === 'original' &&
        (d.page_urls.length > 0 ? (
          <div className="h-[75vh]">
            <PageViewer pages={d.page_urls} fileUrl={d.file_url} />
          </div>
        ) : (
          <Card className="p-6 text-sm text-slate-600">
            <a href={d.file_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-brand-700 hover:underline">
              <FileJson className="h-4 w-4" />
              {d.filename}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Card>
        ))}

      {tab === 'structured' && <Structured d={d} />}

      {tab === 'fhir' &&
        (fhir.isLoading ? (
          <Spinner />
        ) : fhir.error ? (
          <ErrorNote error={fhir.error} />
        ) : fhir.data ? (
          <FhirBundleView
            bundle={fhir.data.bundle}
            errors={fhir.data.validation_errors}
            filename={`${(d.title || 'document').replace(/\s+/g, '-').toLowerCase()}.fhir.json`}
          />
        ) : null)}
    </div>
  )
}

function Structured({ d }: { d: DocumentInfo }) {
  const { t } = useTranslation()
  const r = d.review
  if (!r) return null
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {r.observations.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader title={t('review.results')} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">{t('review.test')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('review.value')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('review.range')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('review.flag')}</th>
                  <th className="px-5 py-2.5 font-medium">LOINC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.observations.map((o) => (
                  <tr key={o.id} className={o.critical ? 'bg-red-50/50' : ''}>
                    <td className="px-5 py-2.5">
                      <p className="font-medium text-slate-900">{o.name}</p>
                      {o.panel && <p className="text-xs text-slate-500">{o.panel}</p>}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-900">
                      {o.value_text ?? fmtNum(o.value_num)} <span className="font-normal text-slate-500">{o.unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{rangeText(o.ref_low, o.ref_high) || o.ref_text || '—'}</td>
                    <td className="px-3 py-2.5">
                      <FlagBadge flag={o.interpretation} />
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-500">{o.loinc ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {r.medications.length > 0 && (
        <Card>
          <CardHeader title={t('review.medicines')} />
          <ul className="divide-y divide-slate-100">
            {r.medications.map((m) => (
              <li key={m.id} className="space-y-1.5 px-5 py-3">
                <p className="font-medium text-slate-900">
                  {m.name} <span className="font-normal text-slate-500">{m.strength}</span>
                </p>
                <p className="text-xs text-slate-500">{[m.generic, m.frequency_text, m.duration_text, m.instructions].filter(Boolean).join(' · ')}</p>
                <MedSchedule morning={m.morning} afternoon={m.afternoon} night={m.night} meal={m.meal_relation} days={m.duration_days} compact />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {r.conditions.length > 0 && (
        <Card>
          <CardHeader title={t('review.diagnoses')} />
          <ul className="divide-y divide-slate-100">
            {r.conditions.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="font-medium text-slate-900">{c.name}</p>
                  {c.icd10_display && <p className="text-xs text-slate-500">{c.icd10_display}</p>}
                </div>
                <div className="flex items-center gap-1.5">
                  {c.verification_status === 'provisional' && <Badge>{t('review.status_provisional')}</Badge>}
                  {c.icd10 && <Badge className="font-mono">{c.icd10}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d.pipeline_log.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader title={t('docview.pipeline')} />
          <ol className="grid grid-cols-1 gap-2 p-5 sm:grid-cols-3 lg:grid-cols-6">
            {d.pipeline_log.map((l, i) => (
              <li key={i} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-xs font-medium text-slate-700">{t(`upload.stage.${l.stage}`, { defaultValue: l.stage })}</p>
                {l.ms != null && <p className="text-xs text-slate-500">{(l.ms / 1000).toFixed(1)} s</p>}
                {l.model && <p className="truncate font-mono text-[10px] text-slate-400">{l.model}</p>}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  )
}
