import { useQuery } from '@tanstack/react-query'
import { CalendarClock, FileText, FlaskConical, Hospital, Pill, ScanLine, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { FlagBadge } from '@/components/medical'
import { Badge, Card, Empty, ErrorNote, PageHeader, Spinner, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { TimelineEvent } from '@/lib/types'
import { cn, fmtDate, fmtNum } from '@/lib/utils'

const ICON: Record<string, typeof FileText> = {
  prescription: Pill,
  lab_report: FlaskConical,
  discharge_summary: Hospital,
  imaging_report: ScanLine,
  other: FileText,
}
const TONE: Record<string, string> = {
  prescription: 'bg-violet-100 text-violet-700',
  lab_report: 'bg-sky-100 text-sky-700',
  discharge_summary: 'bg-rose-100 text-rose-700',
  imaging_report: 'bg-amber-100 text-amber-700',
  other: 'bg-slate-100 text-slate-600',
}

export default function Timeline() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const [filter, setFilter] = useState('all')
  const q = useQuery({ queryKey: ['timeline', patient.id], queryFn: () => api.timeline(patient.id) })

  const types = useMemo(() => Array.from(new Set((q.data ?? []).map((e) => e.type))), [q.data])
  const events = (q.data ?? []).filter((e) => filter === 'all' || e.type === filter)
  const byYear = useMemo(() => {
    const groups: [string, TimelineEvent[]][] = []
    for (const e of events) {
      const y = e.date ? e.date.slice(0, 4) : '—'
      const last = groups[groups.length - 1]
      if (last && last[0] === y) last[1].push(e)
      else groups.push([y, [e]])
    }
    return groups
  }, [events])

  return (
    <div>
      <PageHeader
        title={t('timeline.title')}
        subtitle={t('timeline.subtitle')}
        action={
          types.length > 1 && (
            <Tabs
              value={filter}
              onChange={setFilter}
              items={[{ value: 'all', label: t('timeline.filter_all') }, ...types.map((x) => ({ value: x, label: t(`doctype.${x}`) }))]}
            />
          )
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : events.length === 0 ? (
        <Card>
          <Empty icon={<CalendarClock className="h-6 w-6" />} title={t('timeline.empty')} />
        </Card>
      ) : (
        <div className="space-y-8">
          {byYear.map(([year, items]) => (
            <section key={year}>
              <h2 className="mb-3 text-sm font-semibold text-slate-400">{year}</h2>
              <ol className="relative space-y-4 border-l-2 border-slate-200 pl-6 sm:ml-2">
                {items.map((e) => (
                  <Event key={e.id} e={e} lang={lang} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function Event({ e, lang }: { e: TimelineEvent; lang: ReturnType<typeof useLang> }) {
  const { t } = useTranslation()
  const Icon = ICON[e.type] ?? FileText
  const to = e.status === 'confirmed' ? `/documents/${e.id}` : `/documents/${e.id}/review`
  return (
    <li className="relative">
      <span className={cn('absolute -left-[37px] top-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-slate-50', TONE[e.type] ?? TONE.other)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <Link to={to}>
        <Card className="p-4 transition-shadow hover:shadow-md">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-500">
                {e.date_known ? fmtDate(e.date, lang, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : t('timeline.date_unknown')}
                {e.encounter?.end && e.encounter.start && e.encounter.end !== e.encounter.start && ` → ${fmtDate(e.encounter.end, lang)}`}
              </p>
              <p className="mt-0.5 font-semibold text-slate-900">{e.title}</p>
              <p className="text-sm text-slate-500">{[t(`doctype.${e.type}`), e.facility, e.author].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {e.source !== 'upload' && e.source !== 'demo' && (
                <Badge className="bg-brand-50 text-brand-700 ring-brand-200">
                  <ShieldCheck className="h-3 w-3" />
                  {t('timeline.imported')}
                </Badge>
              )}
              {e.handwritten && <Badge>{t('timeline.handwritten')}</Badge>}
              {e.languages.filter((l) => l !== 'en').length > 0 && <Badge>{e.languages.join('+').toUpperCase()}</Badge>}
              {e.status === 'review' && <Badge className="bg-amber-50 text-amber-800 ring-amber-200">{t('timeline.pending')}</Badge>}
              {(e.status === 'processing' || e.status === 'queued') && <Badge>{t('timeline.processing')}</Badge>}
              {e.critical_count > 0 && <Badge className="bg-red-50 text-red-700 ring-red-200">{t('timeline.critical', { count: e.critical_count })}</Badge>}
              {e.abnormal_count > 0 && e.abnormal_count !== e.critical_count && (
                <Badge className="bg-amber-50 text-amber-800 ring-amber-200">{t('timeline.abnormal', { count: e.abnormal_count })}</Badge>
              )}
            </div>
          </div>

          {(e.highlights.length > 0 || e.medications.length > 0 || e.conditions.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {e.highlights.map((h, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
                  {h.name} <span className="font-semibold">{fmtNum(h.value)}</span> {h.unit}
                  {h.flag && h.flag !== 'N' && <FlagBadge flag={h.flag} />}
                </span>
              ))}
              {e.medications.map((m, i) => (
                <span key={`m${i}`} className="inline-flex items-center gap-1 rounded-lg bg-violet-50 px-2 py-1 text-xs text-violet-800 ring-1 ring-violet-100">
                  <Pill className="h-3 w-3" />
                  {m}
                </span>
              ))}
              {e.conditions.map((c, i) => (
                <span key={`c${i}`} className="rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-800 ring-1 ring-rose-100">
                  {c}
                </span>
              ))}
            </div>
          )}
        </Card>
      </Link>
    </li>
  )
}
