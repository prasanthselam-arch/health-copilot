import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, FileCheck2, Link2, Link2Off, ShieldCheck, Smartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, CardHeader, ErrorNote, Input, Label, PageHeader } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import { cn, fmtDate } from '@/lib/utils'

const HI_TYPES = [
  { value: 'Prescription', key: 'prescription' },
  { value: 'DiagnosticReport', key: 'diagnostic' },
  { value: 'DischargeSummary', key: 'discharge' },
]

export default function Abha() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const qc = useQueryClient()
  const [id, setId] = useState('')
  const [txn, setTxn] = useState<{ txn_id: string; message: string; demo_otp_hint: string } | null>(null)
  const [otp, setOtp] = useState('')
  const [types, setTypes] = useState<string[]>(HI_TYPES.map((h) => h.value))
  const linked = Boolean(patient.abha_linked_at)

  const refreshPatient = () => qc.invalidateQueries({ queryKey: ['patients'] })
  const refreshRecords = () =>
    Promise.all([['documents', patient.id], ['profile', patient.id], ['timeline', patient.id], ['trends', patient.id], ['medications', patient.id]].map((k) => qc.invalidateQueries({ queryKey: k })))

  const init = useMutation({
    mutationFn: () => {
      const v = id.trim()
      return api.abhaInit(patient.id, /[a-z@]/i.test(v) ? { abha_address: v } : { abha_number: v.replace(/\D/g, '') })
    },
    onSuccess: setTxn,
  })
  const verify = useMutation({
    mutationFn: () => api.abhaConfirm(patient.id, txn!.txn_id, otp.trim()),
    onSuccess: () => {
      setTxn(null)
      setOtp('')
      refreshPatient()
    },
  })
  const imp = useMutation({
    mutationFn: () => api.abhaImport(patient.id, types),
    onSuccess: () => {
      refreshRecords()
      // re-import replaces the documents in place, so their cached summaries and bundles are stale
      for (const k of [['patientSummary', patient.id], ['docSummary'], ['docFhir'], ['document']]) qc.removeQueries({ queryKey: k })
    },
  })
  const unlink = useMutation({
    mutationFn: () => api.abhaUnlink(patient.id),
    onSuccess: () => {
      imp.reset()
      refreshPatient()
    },
  })

  const formatAbha = (v: string) => {
    if (v.includes('@') || /[a-z]/i.test(v)) return v
    const d = v.replace(/\D/g, '').slice(0, 14)
    return [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10), d.slice(10, 14)].filter(Boolean).join('-')
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('abha.title')} subtitle={t('abha.subtitle')} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<ShieldCheck className="h-5 w-5" />}
            title="ABHA"
            action={
              <Badge className={linked ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : ''}>
                {linked ? <CheckCircle2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
                {linked ? t('abha.linked') : t('abha.not_linked')}
              </Badge>
            }
          />
          <div className="p-5">
            {linked ? (
              <div className="space-y-4">
                <div className="rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white shadow-inner">
                  <p className="text-xs uppercase tracking-widest text-brand-100">Ayushman Bharat Health Account</p>
                  <p className="mt-3 font-mono text-xl tracking-wider">{patient.abha_number ? formatAbha(patient.abha_number) : '—'}</p>
                  <p className="mt-1 text-brand-100">{patient.abha_address}</p>
                  <p className="mt-4 text-sm font-medium">{patient.name}</p>
                  {patient.abha_linked_at && <p className="text-xs text-brand-200">{fmtDate(patient.abha_linked_at, lang)}</p>}
                </div>
                <Button variant="danger" size="sm" loading={unlink.isPending} onClick={() => window.confirm(t('abha.unlink_confirm')) && unlink.mutate()}>
                  <Link2Off className="h-4 w-4" />
                  {t('abha.unlink')}
                </Button>
              </div>
            ) : !txn ? (
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault()
                  init.mutate()
                }}
                className="space-y-4"
              >
                <label className="block">
                  <Label>{`${t('abha.number')} ${t('abha.or')} ${t('abha.address')}`}</Label>
                  <Input value={id} onChange={(e) => setId(formatAbha(e.target.value))} placeholder="91-1234-5678-9012  /  name@abdm" />
                </label>
                {init.error && <ErrorNote error={init.error} />}
                <Button type="submit" loading={init.isPending} disabled={!id.trim()}>
                  <Smartphone className="h-4 w-4" />
                  {t('abha.send_otp')}
                </Button>
              </form>
            ) : (
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault()
                  verify.mutate()
                }}
                className="space-y-4"
              >
                <p className="text-sm text-slate-600">{txn.message}</p>
                <label className="block">
                  <Label>{t('abha.otp')}</Label>
                  <Input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className="font-mono text-lg tracking-[0.5em]" autoFocus />
                </label>
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">{t('abha.demo_otp', { otp: txn.demo_otp_hint })}</p>
                {verify.error && <ErrorNote error={verify.error} />}
                <div className="flex gap-2">
                  <Button type="submit" loading={verify.isPending} disabled={otp.length < 4}>
                    <Link2 className="h-4 w-4" />
                    {t('abha.verify')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setTxn(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        <Card className={cn(!linked && 'opacity-60')}>
          <CardHeader icon={<FileCheck2 className="h-5 w-5" />} title={t('abha.import_title')} subtitle={t('abha.import_body')} />
          <div className="space-y-4 p-5">
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">{t('abha.hi_types')}</p>
              <div className="flex flex-wrap gap-2">
                {HI_TYPES.map((h) => {
                  const on = types.includes(h.value)
                  return (
                    <button
                      key={h.value}
                      type="button"
                      disabled={!linked}
                      onClick={() => setTypes(on ? types.filter((x) => x !== h.value) : [...types, h.value])}
                      className={cn(
                        'rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors',
                        on ? 'bg-brand-50 text-brand-800 ring-brand-300' : 'bg-white text-slate-500 ring-slate-200',
                      )}
                    >
                      {on && <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />}
                      {t(`abha.${h.key}`)}
                    </button>
                  )
                })}
              </div>
            </div>
            <Button disabled={!linked || types.length === 0} loading={imp.isPending} onClick={() => imp.mutate()}>
              <ShieldCheck className="h-4 w-4" />
              {imp.isPending ? t('abha.importing') : t('abha.import_btn')}
            </Button>
            {imp.error && <ErrorNote error={imp.error} />}
            {imp.data && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('abha.imported', { count: imp.data.imported.length })}
                  {imp.data.fhir_validation_errors.length === 0 && <span className="font-normal text-slate-500">· {t('docview.fhir_valid')}</span>}
                </p>
                <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
                  {imp.data.imported.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span>
                        <span className="font-medium text-slate-900">{r.title}</span>
                        <span className="ml-2 text-slate-500">{t(`doctype.${r.type}`)}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        {r.date && <span className="text-slate-500">{fmtDate(r.date, lang)}</span>}
                        <Link to={`/documents/${r.id}`} className="text-brand-700 hover:underline">
                          {t('common.view')}
                        </Link>
                      </span>
                    </li>
                  ))}
                </ul>
                <details className="rounded-xl bg-slate-50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-slate-700">{t('abha.consent')}</summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-slate-500">{t('abha.consent_id')}</dt>
                    <dd className="font-mono">{imp.data.consent.consent_id}</dd>
                    <dt className="text-slate-500">{t('abha.purpose')}</dt>
                    <dd>{String((imp.data.consent.purpose as { text?: string } | undefined)?.text ?? '')}</dd>
                    <dt className="text-slate-500">{t('abha.hi_types')}</dt>
                    <dd>{imp.data.consent.hi_types.join(', ')}</dd>
                    <dt className="text-slate-500">{t('abha.date_range')}</dt>
                    <dd>
                      {fmtDate(imp.data.consent.permission.date_range.from, lang)} – {fmtDate(imp.data.consent.permission.date_range.to, lang)}
                    </dd>
                  </dl>
                  <pre className="scrollbar-thin mt-3 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{JSON.stringify(imp.data.consent, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={<Download className="h-5 w-5" />}
          title={t('abha.export_title')}
          subtitle={t('abha.export_body')}
          action={
            <a href={api.fhirExportUrl(patient.id)} download>
              <Button variant="secondary">
                <Download className="h-4 w-4" />
                {t('abha.export_btn')}
              </Button>
            </a>
          }
        />
      </Card>
    </div>
  )
}
