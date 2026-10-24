import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, BellOff, BellRing, Bot, Check, CheckCircle2, Clock, FileText, Moon, SkipForward, Sun, Sunset, Undo2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { useLang } from '@/lib/patient'
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push'
import type { Dose, Evidence, Insight } from '@/lib/types'
import { cn, fmtDate, fmtNum } from '@/lib/utils'
import { Badge, Button } from './ui'

export const SLOT_ICON = { morning: Sun, afternoon: Sunset, night: Moon } as const

/** Invalidate everything that shows doses, reminders or copilot state. */
export function useCareRefresh() {
  const qc = useQueryClient()
  return () => Promise.all(['today', 'reminders', 'dueDoses', 'care', 'copilot'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
}

export function EvidenceChips({ items, className }: { items: Evidence[]; className?: string }) {
  const lang = useLang()
  if (!items.length) return null
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((e) => (
        <li key={e.id}>
          <Link
            to={e.document_id ? `/documents/${e.document_id}` : '/trends'}
            className="inline-flex items-center gap-1 rounded-lg bg-white/70 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-900/[0.08] transition-colors hover:bg-brand-50 hover:text-brand-800"
          >
            <FileText className="h-3 w-3 text-slate-400" />
            <span className="font-medium">{typeof e.value === 'number' ? fmtNum(e.value) : e.value}</span>
            {e.unit && <span className="text-slate-500">{e.unit}</span>}
            {e.date && <span className="text-slate-400">· {fmtDate(e.date, lang, { month: 'short', year: 'numeric' })}</span>}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export const LEVEL_TONE: Record<Insight['level'], string> = {
  attention: 'bg-rose-50/80 ring-rose-200 dark:bg-rose-500/10',
  watch: 'bg-amber-50/80 ring-amber-200 dark:bg-amber-500/10',
  good: 'bg-emerald-50/80 ring-emerald-200 dark:bg-emerald-500/10',
}

export function LevelBadge({ level }: { level: Insight['level'] }) {
  const { t } = useTranslation()
  const tone = { attention: 'bg-rose-100 text-rose-800 ring-rose-200', watch: 'bg-amber-100 text-amber-800 ring-amber-200', good: 'bg-emerald-100 text-emerald-800 ring-emerald-200' }[level]
  return <Badge className={tone}>{t(`care.level_${level}`)}</Badge>
}

export function DoseStatusBadge({ d }: { d: Dose }) {
  const { t } = useTranslation()
  const tone: Record<string, string> = {
    taken: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    skipped: 'bg-slate-100 text-slate-600 ring-slate-200',
    snoozed: 'bg-sky-100 text-sky-800 ring-sky-200',
    missed: 'bg-rose-100 text-rose-800 ring-rose-200',
    due: 'bg-amber-100 text-amber-800 ring-amber-200',
    pending: 'bg-slate-50 text-slate-500 ring-slate-200',
  }
  return <Badge className={tone[d.status]}>{t(`rem.status_${d.status}`)}</Badge>
}

export function DoseActions({ d, size = 'sm' }: { d: Dose; size?: 'sm' | 'md' }) {
  const { t } = useTranslation()
  const refresh = useCareRefresh()
  const m = useMutation({
    mutationFn: (v: { action: 'taken' | 'skipped' | 'snoozed' | 'undo'; minutes?: number }) => api.dose(d.reminder_id, { day: d.day, time: d.time, ...v }),
    onSuccess: refresh,
  })
  if (d.status === 'taken' || d.status === 'skipped') {
    return (
      <Button variant="ghost" size="sm" onClick={() => m.mutate({ action: 'undo' })} loading={m.isPending}>
        <Undo2 className="h-3.5 w-3.5" />
        {t('rem.undo')}
      </Button>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size={size} onClick={() => m.mutate({ action: 'taken' })} loading={m.isPending && m.variables?.action === 'taken'}>
        <Check className="h-4 w-4" />
        {t('rem.taken')}
      </Button>
      <Button variant="secondary" size={size} onClick={() => m.mutate({ action: 'snoozed', minutes: 15 })} loading={m.isPending && m.variables?.action === 'snoozed'}>
        <AlarmClock className="h-4 w-4" />
        {t('rem.snooze')}
      </Button>
      <Button variant="ghost" size={size} onClick={() => m.mutate({ action: 'skipped' })} title={t('rem.skip')} aria-label={t('rem.skip')}>
        <SkipForward className="h-4 w-4" />
        <span className="hidden sm:inline">{t('rem.skip')}</span>
      </Button>
    </div>
  )
}

export function DoseRow({ d, showPatient }: { d: Dose; showPatient?: boolean }) {
  const { t } = useTranslation()
  const Icon = SLOT_ICON[d.slot] ?? Clock
  const done = d.status === 'taken' || d.status === 'skipped'
  return (
    <li
      className={cn(
        'grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[4rem_minmax(0,1fr)_auto_auto] sm:items-center sm:px-5',
        d.status === 'due' && 'bg-amber-50/60 dark:bg-amber-500/10',
      )}
    >
      <div className="flex items-center gap-1.5 pt-0.5 font-semibold tabular-nums text-slate-900 sm:pt-0">
        <Icon className="hidden h-4 w-4 text-brand-600 sm:block" />
        {d.time}
      </div>
      <div className="min-w-0">
        <p className={cn('truncate font-medium text-slate-900', done && 'text-slate-500 line-through decoration-slate-300')}>{d.title}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-slate-500">
          <span>{[d.amount, d.detail && t(`rem.meal.${d.detail}`, { defaultValue: d.detail })].filter(Boolean).join(' · ')}</span>
          {showPatient && <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-800">{d.patient_name.split(' ')[0]}</span>}
        </p>
      </div>
      <div className="justify-self-end">{d.status !== 'pending' && <DoseStatusBadge d={d} />}</div>
      <div className="col-span-2 col-start-2 sm:col-span-1 sm:col-start-auto sm:justify-self-end">
        <DoseActions d={d} />
      </div>
    </li>
  )
}

/** Floating card in the app shell for a dose that is due right now (works even without push notifications). */
export function DueDoseToast() {
  const { t } = useTranslation()
  const [hidden, setHidden] = useState<string[]>([])
  const q = useQuery({ queryKey: ['dueDoses'], queryFn: api.dueDoses, refetchInterval: 60_000, refetchOnWindowFocus: true })
  const refresh = useCareRefresh()
  useEffect(() => {
    const onMsg = (e: MessageEvent) => e.data?.type === 'dose-updated' && refresh()
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [refresh])
  const due = (q.data ?? []).filter((d) => !hidden.includes(`${d.reminder_id}${d.time}`))
  if (!due.length) return null
  const d = due[0]
  return (
    <div className="fixed inset-x-3 bottom-20 z-30 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[26rem] print:hidden" role="status" aria-live="polite">
      <div className="surface rounded-2xl p-4 shadow-2xl ring-1 ring-amber-300">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-amber-100 p-2 text-amber-700">
            <BellRing className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-amber-700 uppercase">
              {t('rem.due_now')} · {d.time}
              {due.length > 1 && ` · +${due.length - 1}`}
            </p>
            <p className="mt-0.5 font-semibold text-slate-900">{d.title}</p>
            <p className="text-sm text-slate-600">
              {d.patient_name} · {[d.amount, d.detail && t(`rem.meal.${d.detail}`, { defaultValue: d.detail })].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-3">
              <DoseActions d={d} />
            </div>
          </div>
          <button onClick={() => setHidden((h) => [...h, `${d.reminder_id}${d.time}`])} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

export function PushToggle({ compact }: { compact?: boolean }) {
  const { t } = useTranslation()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    pushState().then(setState)
  }, [])
  if (state === null) return null
  if (state === 'unsupported' || state === 'denied')
    return compact ? null : (
      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t(state === 'denied' ? 'rem.push_denied' : 'rem.push_unsupported')}
      </p>
    )
  const toggle = async () => {
    setBusy(true)
    try {
      setState(state === 'on' ? await disablePush() : await enablePush())
    } finally {
      setBusy(false)
    }
  }
  return state === 'on' ? (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="bg-emerald-100 text-emerald-800 ring-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('rem.push_on')}
      </Badge>
      {!compact && (
        <Button variant="ghost" size="sm" onClick={toggle} loading={busy}>
          {t('rem.push_off')}
        </Button>
      )}
    </div>
  ) : (
    <Button variant="secondary" size="sm" onClick={toggle} loading={busy}>
      <BellRing className="h-4 w-4 text-brand-600" />
      {t('rem.push_enable')}
    </Button>
  )
}

/** Shown after confirming a document: what the copilot just did with it. */
export function CopilotDidBanner({ actions }: { actions: { id: string; kind: string; title: string }[] }) {
  const { t } = useTranslation()
  if (!actions.length) return null
  return (
    <div className="rounded-2xl bg-gradient-to-r from-brand-50 to-sky-50 p-4 ring-1 ring-brand-200 dark:from-brand-500/10 dark:to-sky-500/10">
      <div className="flex flex-wrap items-start gap-3">
        <span className="rounded-xl bg-brand-600 p-2 text-white">
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">{t('copilot.just_did')}</p>
          <ul className="mt-1.5 space-y-1 text-sm text-slate-700">
            {actions.map((a) => (
              <li key={a.id} className="flex items-start gap-1.5">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                {a.title}
              </li>
            ))}
          </ul>
        </div>
        <Link to="/copilot">
          <Button size="sm" variant="secondary">
            {t('copilot.review_actions')}
          </Button>
        </Link>
      </div>
    </div>
  )
}
