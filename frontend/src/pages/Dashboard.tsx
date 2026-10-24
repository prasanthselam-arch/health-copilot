import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowRight, BellRing, Bot, ClipboardCheck, FileText, FlaskConical, HeartPulse, MailWarning, MessageCircleHeart, Pill, ShieldCheck, Sparkles, Stethoscope, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CriticalBanner, FlagBadge, MedSchedule } from '@/components/medical'
import { SummaryView } from '@/components/SummaryView'
import { DoseRow, LevelBadge, PushToggle } from '@/components/care'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useActivePatient, useLang } from '@/lib/patient'
import { fmtDate, fmtNum, rangeText } from '@/lib/utils'

export default function Dashboard() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const [wantSummary, setWantSummary] = useState(false)

  const profile = useQuery({
    queryKey: ['profile', patient.id],
    queryFn: () => api.profile(patient.id),
    refetchInterval: (q) => ((q.state.data?.counts.processing ?? 0) > 0 ? 3000 : false),
  })
  const summary = useQuery({
    queryKey: ['patientSummary', patient.id, lang],
    queryFn: () => api.patientSummary(patient.id, lang),
    enabled: wantSummary,
    staleTime: 5 * 60_000,
  })

  if (profile.isLoading) return <Spinner label={t('common.loading')} />
  if (profile.error) return <ErrorNote error={profile.error} onRetry={() => profile.refetch()} />
  const p = profile.data!
  const c = p.counts
  const hasData = c.documents > 0

  return (
    <div className="space-y-6">
      <Hero
        name={patient.name.split(' ')[0]}
        lastRecord={p.last_record_date ? fmtDate(p.last_record_date, lang) : null}
        stats={
          hasData
            ? [
                { icon: <FileText className="h-5 w-5" />, label: t('dashboard.docs'), value: c.documents, to: '/timeline', tone: 'from-sky-400 to-indigo-500' },
                { icon: <FlaskConical className="h-5 w-5" />, label: t('dashboard.results'), value: c.results, to: '/trends', tone: 'from-brand-300 to-brand-600' },
                { icon: <Pill className="h-5 w-5" />, label: t('dashboard.active_meds'), value: c.medications, to: '/medications', tone: 'from-amber-300 to-orange-500' },
                { icon: <Stethoscope className="h-5 w-5" />, label: t('dashboard.conditions'), value: c.conditions, tone: 'from-rose-300 to-pink-500' },
              ]
            : []
        }
      />

      <VerifyEmailBanner />

      {c.pending_review > 0 && <PendingReview patientId={patient.id} count={c.pending_review} />}

      {p.critical.length > 0 && (
        <CriticalBanner
          title={t('dashboard.critical_title')}
          items={p.critical.map((o) => ({ label: o.name, detail: `${o.value_text ?? fmtNum(o.value_num)} ${o.unit ?? ''}`.trim() }))}
          note={t('dashboard.critical_note')}
        />
      )}

      {!hasData && c.pending_review === 0 && c.processing === 0 ? (
        <Card>
          <Empty
            icon={<FileText className="h-6 w-6" />}
            title={t('dashboard.empty_title')}
            body={t('dashboard.empty_body')}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link to="/upload">
                  <Button>
                    <Upload className="h-4 w-4" />
                    {t('dashboard.upload_cta')}
                  </Button>
                </Link>
                <Link to="/abha">
                  <Button variant="secondary">
                    <ShieldCheck className="h-4 w-4" />
                    {t('dashboard.abha_cta')}
                  </Button>
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <CareStrip patientId={patient.id} />

          <Card className="overflow-hidden">
            <div className="theme-fixed relative flex flex-wrap items-center justify-between gap-3 overflow-hidden bg-gradient-to-r from-brand-700 via-brand-600 to-sky-600 px-5 py-4 text-white">
              <div className="bg-dots pointer-events-none absolute inset-0 opacity-60" />
              <div className="relative flex items-center gap-3">
                <span className="rounded-xl bg-white/15 p-2 ring-1 ring-white/25 backdrop-blur">
                  <Sparkles className="h-5 w-5" />
                </span>
                <h3 className="text-lg font-semibold">{t('dashboard.ai_summary')}</h3>
              </div>
              {!wantSummary && (
                <Button variant="secondary" className="relative" onClick={() => setWantSummary(true)} disabled={!hasData}>
                  <Sparkles className="h-4 w-4 text-brand-600" />
                  {t('dashboard.generate_summary')}
                </Button>
              )}
            </div>
            {wantSummary && (
              <div className="p-5">
                {summary.isFetching && !summary.data ? (
                  <Spinner label={t('dashboard.summary_loading')} />
                ) : summary.error ? (
                  <ErrorNote error={summary.error} onRetry={() => summary.refetch()} />
                ) : summary.data ? (
                  <SummaryView s={summary.data} />
                ) : null}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader icon={<Activity className="h-5 w-5" />} title={t('dashboard.abnormal_title')} />
              {p.abnormal_latest.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">{t('dashboard.abnormal_empty')}</p>
              ) : (
                <ul className="divide-y divide-slate-900/[0.05]">
                  {p.abnormal_latest.map((o) => (
                    <li key={o.id}>
                      <Link to={o.document_id ? `/documents/${o.document_id}` : '/trends'} className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{o.name}</p>
                          <p className="text-xs text-slate-500">
                            {rangeText(o.ref_low, o.ref_high) || o.ref_text} {o.effective_date && `· ${fmtDate(o.effective_date, lang)}`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {o.value_text ?? fmtNum(o.value_num)} <span className="text-xs font-normal text-slate-500">{o.unit}</span>
                          </span>
                          <FlagBadge flag={o.interpretation} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                icon={<Pill className="h-5 w-5" />}
                title={t('dashboard.meds_title')}
                action={
                  <Link to="/medications" aria-label={t('nav.medications')} className="text-sm text-brand-700 hover:underline">
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                }
              />
              {p.active_medications.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">{t('dashboard.meds_empty')}</p>
              ) : (
                <ul className="divide-y divide-slate-900/[0.05]">
                  {p.active_medications.map((m) => (
                    <li key={m.id} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900">
                          {m.name} <span className="font-normal text-slate-500">{m.strength}</span>
                        </p>
                        {m.generic && m.generic.toLowerCase() !== m.name.toLowerCase() && <p className="truncate text-xs text-slate-500">{m.generic}</p>}
                      </div>
                      <MedSchedule morning={m.morning} afternoon={m.afternoon} night={m.night} meal={m.meal_relation} compact />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader icon={<Stethoscope className="h-5 w-5" />} title={t('dashboard.conditions_title')} />
              {p.conditions.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">{t('dashboard.conditions_empty')}</p>
              ) : (
                <ul className="flex flex-wrap gap-2 p-5">
                  {p.conditions.map((cd) => (
                    <li key={cd.id} className="rounded-xl bg-gradient-to-br from-white to-slate-50 px-3.5 py-2.5 shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.06]">
                      <p className="text-sm font-medium text-slate-900">{cd.name}</p>
                      <p className="text-xs text-slate-500">
                        {cd.icd10 && <span className="font-mono">{cd.icd10}</span>}
                        {cd.recorded_date && ` · ${fmtDate(cd.recorded_date, lang)}`}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader icon={<HeartPulse className="h-5 w-5" />} title={t('dashboard.vitals_title')} />
              {p.latest_vitals.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">—</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">
                  {p.latest_vitals.map((v) => (
                    <div key={v.id} className="rounded-xl bg-gradient-to-br from-white to-brand-50/50 p-3.5 shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.06]">
                      <p className="truncate text-xs text-slate-500">{v.name}</p>
                      <p className="mt-0.5 font-display text-xl font-bold text-slate-900 tabular-nums">
                        {v.value_text ?? fmtNum(v.value_num)} <span className="text-xs font-normal text-slate-500">{v.unit}</span>
                      </p>
                      <FlagBadge flag={v.interpretation} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

interface HeroStat {
  icon: ReactNode
  label: string
  value: number
  to?: string
  tone: string
}

function Hero({ name, lastRecord, stats }: { name: string; lastRecord: string | null; stats: HeroStat[] }) {
  const { t } = useTranslation()
  const lang = useLang()
  const today = new Date().toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <section className="theme-fixed relative overflow-hidden rounded-3xl bg-ink-900 text-white shadow-[var(--shadow-lift)]">
      <div className="bg-dots pointer-events-none absolute inset-0 opacity-40" />
      <div className="animate-float pointer-events-none absolute -top-28 -right-20 h-80 w-80 rounded-full bg-brand-500/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-sky-500/15 blur-3xl" />
      <svg className="pointer-events-none absolute right-0 bottom-0 h-28 w-[28rem] max-w-full text-brand-400/25" viewBox="0 0 400 100" fill="none" aria-hidden>
        <path d="M0 70h120l14-30 22 52 18-40 12 18h214" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <div className="relative flex flex-wrap items-end justify-between gap-6 p-6 sm:p-8">
        <div className="max-w-xl">
          <p className="text-xs font-semibold tracking-[0.14em] text-brand-300 uppercase">{today}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{t('dashboard.greeting', { name })}</h1>
          <p className="mt-2 text-slate-300">{t('dashboard.subtitle')}</p>
          {lastRecord && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1 text-xs text-slate-300 ring-1 ring-white/10">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400 shadow-[0_0_8px_rgb(69_194_165)]" />
              {t('dashboard.last_record')}: {lastRecord}
            </p>
          )}
        </div>
        <div className="grid w-full grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:w-auto sm:flex-wrap">
          <Link to="/upload" className="[&>button]:w-full">
            <Button className="bg-none bg-white text-ink-900 shadow-[0_10px_30px_-10px_rgb(255_255_255/0.5)] hover:bg-brand-50">
              <Upload className="h-4 w-4" />
              {t('dashboard.upload_cta')}
            </Button>
          </Link>
          <Link to="/chat" className="[&>button]:w-full">
            <Button variant="ghost" className="bg-white/[0.08] text-white ring-1 ring-white/15 hover:bg-white/15 hover:text-white">
              <MessageCircleHeart className="h-4 w-4" />
              {t('dashboard.ask_cta')}
            </Button>
          </Link>
        </div>
      </div>

      {stats.length > 0 && (
        <div className="relative grid grid-cols-2 gap-px border-t border-white/[0.08] bg-white/[0.06] md:grid-cols-4">
          {stats.map((s) => {
            const body = (
              <div className="group flex h-full items-center gap-3 bg-ink-900/80 px-4 py-4 transition-colors hover:bg-ink-800/80 sm:px-6">
                <span className={`shrink-0 rounded-xl bg-gradient-to-br ${s.tone} p-2.5 text-white shadow-lg ring-1 ring-white/20`}>{s.icon}</span>
                <div className="min-w-0">
                  <p className="font-display text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="line-clamp-2 text-xs leading-snug text-slate-400 group-hover:text-slate-300 sm:truncate">{s.label}</p>
                </div>
                {s.to && <ArrowRight className="ml-auto hidden h-4 w-4 shrink-0 text-slate-600 transition-all group-hover:translate-x-0.5 group-hover:text-slate-300 sm:block" />}
              </div>
            )
            return s.to ? (
              <Link key={s.label} to={s.to}>
                {body}
              </Link>
            ) : (
              <div key={s.label}>{body}</div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function PendingReview({ patientId, count }: { patientId: string; count: number }) {
  const { t } = useTranslation()
  const docs = useQuery({
    queryKey: ['documents', patientId],
    queryFn: () => api.documents(patientId),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'review') ? false : 4000),
  })
  const first = docs.data?.find((d) => d.status === 'review')
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 px-5 py-4 shadow-[var(--shadow-soft)] ring-1 ring-amber-200/80">
      <div className="flex items-center gap-3 text-amber-900">
        <ClipboardCheck className="h-5 w-5" />
        <span className="font-medium">{t('dashboard.review_pending', { count })}</span>
        {first?.doc_type && <Badge className="bg-white">{t(`doctype.${first.doc_type}`)}</Badge>}
      </div>
      {first && (
        <Link to={`/documents/${first.id}/review`}>
          <Button size="sm">
            {t('dashboard.review_now')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      )}
    </div>
  )
}

function VerifyEmailBanner() {
  const { t } = useTranslation()
  const { account } = useAuth()
  if (!account || account.email_verified) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-sky-50 to-indigo-50 px-5 py-4 shadow-[var(--shadow-soft)] ring-1 ring-sky-200/80">
      <div className="flex items-start gap-3 text-sky-950">
        <MailWarning className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
        <div>
          <p className="font-medium">{t('email.banner_title')}</p>
          <p className="text-sm text-sky-900/80">{t('email.banner_body')}</p>
        </div>
      </div>
      <Link to="/account#email">
        <Button size="sm">
          {t('email.banner_action')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </Link>
    </div>
  )
}


/** Today's doses for this person and what the copilot found, right on the home screen. */
function CareStrip({ patientId }: { patientId: string }) {
  const { t } = useTranslation()
  const lang = useLang()
  const today = useQuery({ queryKey: ['today', 'home'], queryFn: () => api.today(), refetchInterval: 60_000 })
  const care = useQuery({ queryKey: ['care', patientId, lang], queryFn: () => api.care(patientId, lang), staleTime: 60_000 })
  const copilot = useQuery({ queryKey: ['copilot', patientId, lang], queryFn: () => api.copilot(patientId, lang) })
  const doses = (today.data?.doses ?? []).filter((d) => d.patient_id === patientId)
  const pending = doses.filter((d) => !['taken', 'skipped'].includes(d.status))
  const shown = (pending.length ? pending : doses).slice(0, 4)
  const attention = (care.data?.insights ?? []).filter((i) => i.level !== 'good').slice(0, 3)
  const due = (care.data?.preventive ?? []).filter((x) => x.status === 'overdue').length
  const proposals = (copilot.data ?? []).filter((a) => a.status === 'proposed').length
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader
          icon={<BellRing className="h-5 w-5" />}
          title={t('rem.today_title')}
          subtitle={doses.length ? t('rem.progress', { done: doses.filter((d) => d.status === 'taken').length, total: doses.length }) : undefined}
          action={
            <div className="flex items-center gap-2">
              <PushToggle compact />
              <Link to="/reminders" aria-label={t('nav.reminders')} className="text-sm text-brand-700 hover:underline">
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          }
        />
        {today.isLoading ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">{t('rem.no_doses')}</p>
        ) : (
          <ul className="divide-y divide-slate-900/[0.05]">
            {shown.map((d) => (
              <DoseRow key={`${d.reminder_id}${d.time}`} d={d} />
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader
          icon={<Bot className="h-5 w-5" />}
          title={t('care.home_title')}
          subtitle={[due ? t('care.home_due', { count: due }) : null, proposals ? t('care.home_proposals', { count: proposals }) : null].filter(Boolean).join(' · ') || undefined}
          action={
            <Link to="/insights" aria-label={t('nav.insights')} className="text-sm text-brand-700 hover:underline">
              <ArrowRight className="h-4 w-4" />
            </Link>
          }
        />
        {care.isLoading ? (
          <Spinner />
        ) : attention.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">{t('care.no_risks')}</p>
        ) : (
          <ul className="divide-y divide-slate-900/[0.05]">
            {attention.map((i) => (
              <li key={i.key}>
                <Link to="/insights" className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{i.title}</p>
                    <p className="line-clamp-2 text-sm text-slate-500">{i.body}</p>
                  </div>
                  <LevelBadge level={i.level} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {proposals > 0 && (
          <div className="border-t border-slate-900/[0.06] px-5 py-3">
            <Link to="/copilot">
              <Button size="sm" variant="secondary">
                <Bot className="h-4 w-4 text-brand-600" />
                {t('care.review_proposals', { count: proposals })}
              </Button>
            </Link>
          </div>
        )}
      </Card>
    </div>
  )
}
