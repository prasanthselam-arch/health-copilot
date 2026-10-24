import { useQuery } from '@tanstack/react-query'
import { Activity, Apple, BedDouble, CalendarClock, Footprints, HeartPulse, Info, ListChecks, Sparkles, Stethoscope, TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { EvidenceChips, LEVEL_TONE, LevelBadge } from '@/components/care'
import { Disclaimer } from '@/components/medical'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, PageHeader, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { Insight, PreventiveItem, WellnessTip } from '@/lib/types'
import { cn, fmtDate } from '@/lib/utils'

const CATEGORY_ICON = { diet: Apple, activity: Footprints, sleep: BedDouble, habits: HeartPulse, monitoring: Activity } as const

export default function Insights() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const q = useQuery({ queryKey: ['care', patient.id, lang], queryFn: () => api.care(patient.id, lang), staleTime: 60_000 })

  if (q.isLoading) return <Spinner label={t('care.loading')} />
  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  const c = q.data!
  const attention = c.insights.filter((i) => i.level !== 'good')
  const good = c.insights.filter((i) => i.level === 'good')
  const due = c.preventive.filter((p) => p.status === 'overdue' || p.status === 'due_soon' || p.status === 'not_done')
  const empty = !c.insights.length && !due.length && !c.wellness.length

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('care.title')}
        subtitle={t('care.subtitle', { name: patient.name.split(' ')[0] })}
        action={
          <Link to="/copilot">
            <Button variant="secondary" size="sm">
              <ListChecks className="h-4 w-4 text-brand-600" />
              {t('care.visit_sheet')}
            </Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat tone="from-rose-300 to-rose-500" label={t('care.stat_attention')} value={attention.length} />
        <Stat tone="from-amber-300 to-orange-500" label={t('care.stat_due')} value={due.length} />
        <Stat tone="from-emerald-300 to-emerald-600" label={t('care.stat_improving')} value={good.length} />
        <Stat
          tone="from-sky-300 to-indigo-500"
          label={t('care.stat_adherence')}
          value={c.adherence.percent != null ? `${c.adherence.percent}%` : '—'}
          to="/reminders"
        />
      </div>

      {!c.translated && lang !== 'en' && <p className="text-sm text-slate-500">{t('care.not_translated')}</p>}

      {empty ? (
        <Card>
          <Empty icon={<Sparkles className="h-6 w-6" />} title={t('care.empty_title')} body={t('care.empty_body')} />
        </Card>
      ) : (
        <>
          <section className="space-y-3">
            <SectionTitle icon={<TrendingUp className="h-4 w-4" />} title={t('care.risks')} sub={t('care.risks_sub')} />
            {attention.length === 0 ? (
              <Card>
                <p className="px-5 py-6 text-sm text-slate-500">{t('care.no_risks')}</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {attention.map((i) => (
                  <InsightCard key={i.key} i={i} />
                ))}
              </div>
            )}
            {good.length > 0 && (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {good.map((i) => (
                  <InsightCard key={i.key} i={i} />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionTitle icon={<CalendarClock className="h-4 w-4" />} title={t('care.next_steps')} sub={t('care.next_steps_sub')} />
            <Card>
              <PreventiveList items={c.preventive} />
            </Card>
          </section>

          <section className="space-y-3">
            <SectionTitle icon={<Sparkles className="h-4 w-4" />} title={t('care.wellness')} sub={t('care.wellness_sub')} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {c.wellness.map((w) => (
                <TipCard key={w.key} w={w} />
              ))}
            </div>
          </section>
        </>
      )}
      <Disclaimer text={c.disclaimer} />
    </div>
  )
}

function Stat({ label, value, tone, to }: { label: string; value: number | string; tone: string; to?: string }) {
  const body = (
    <Card className="relative overflow-hidden p-4">
      <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', tone)} />
      <p className="text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
      <p className="text-sm text-slate-500">{label}</p>
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function SectionTitle({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <span className="text-brand-600">{icon}</span>
        {title}
      </h2>
      <p className="text-sm text-slate-500">{sub}</p>
    </div>
  )
}

export function InsightCard({ i }: { i: Insight }) {
  const { t } = useTranslation()
  const Icon = i.level === 'good' ? TrendingDown : i.kind === 'combination' ? Stethoscope : TrendingUp
  return (
    <div className={cn('rounded-2xl p-4 ring-1', LEVEL_TONE[i.level])}>
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', i.level === 'attention' ? 'text-rose-600' : i.level === 'watch' ? 'text-amber-600' : 'text-emerald-600')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{i.title}</p>
            <LevelBadge level={i.level} />
          </div>
          <p className="mt-1 text-sm text-slate-700">{i.body}</p>
          <EvidenceChips items={i.evidence} className="mt-2" />
          {i.next_step && (
            <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-slate-800">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              {i.next_step}
            </p>
          )}
          {i.question && <p className="mt-1.5 text-xs text-slate-500">{t('care.ask_doctor')}: “{i.question}”</p>}
        </div>
      </div>
    </div>
  )
}

const STATUS_TONE: Record<PreventiveItem['status'], string> = {
  overdue: 'bg-rose-100 text-rose-800 ring-rose-200',
  due_soon: 'bg-amber-100 text-amber-800 ring-amber-200',
  not_done: 'bg-violet-100 text-violet-800 ring-violet-200',
  ok: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  ask: 'bg-slate-100 text-slate-700 ring-slate-200',
}

export function PreventiveList({ items, compact }: { items: PreventiveItem[]; compact?: boolean }) {
  const { t } = useTranslation()
  const lang = useLang()
  if (!items.length) return <p className="px-5 py-6 text-sm text-slate-500">{t('care.no_next_steps')}</p>
  return (
    <ul className="divide-y divide-slate-900/[0.05]">
      {items.map((p) => (
        <li key={p.key} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-[1_1_16rem]">
            <p className="font-medium text-slate-900">{p.title}</p>
            {!compact && <p className="mt-0.5 text-sm text-slate-600">{p.why}</p>}
            <p className="mt-0.5 text-xs text-slate-400">
              {p.last_date && `${t('care.last_done')} ${fmtDate(p.last_date, lang)} · `}
              {p.source}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge className={STATUS_TONE[p.status]}>{t(`care.status_${p.status}`)}</Badge>
            {p.due_date && p.status !== 'not_done' && <span className="text-xs text-slate-500">{fmtDate(p.due_date, lang)}</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function TipCard({ w }: { w: WellnessTip }) {
  const { t } = useTranslation()
  const Icon = CATEGORY_ICON[w.category] ?? Sparkles
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t(`care.cat_${w.category}`)}</span>
      </div>
      <p className="mt-2 font-semibold text-slate-900">{w.title}</p>
      <p className="mt-1 text-sm text-slate-700">{w.body}</p>
      <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 dark:bg-white/[0.04]">
        <span className="font-semibold">{t('care.why')}:</span> {w.why}
      </p>
      <EvidenceChips items={w.evidence} className="mt-2" />
    </Card>
  )
}

export function CardHeaderLink({ title, icon, to, label }: { title: string; icon: ReactNode; to: string; label: string }) {
  return (
    <CardHeader
      icon={icon}
      title={title}
      action={
        <Link to={to} className="text-sm font-medium text-brand-700 hover:underline">
          {label}
        </Link>
      }
    />
  )
}
