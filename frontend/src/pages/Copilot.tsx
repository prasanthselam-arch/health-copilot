import { useMutation, useQuery } from '@tanstack/react-query'
import { AlarmClockOff, BellRing, Bot, CalendarPlus, CalendarX, Check, FlaskConical, MessageSquareQuote, Pencil, Plus, Printer, Undo2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useCareRefresh } from '@/components/care'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, PageHeader, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { CopilotAction } from '@/lib/types'
import { cn, fmtDate } from '@/lib/utils'

const KIND_ICON: Record<CopilotAction['kind'], ReactNode> = {
  reminders: <BellRing className="h-4 w-4" />,
  reminders_stopped: <AlarmClockOff className="h-4 w-4" />,
  appointment: <CalendarPlus className="h-4 w-4" />,
  test_due: <FlaskConical className="h-4 w-4" />,
  overdue: <CalendarX className="h-4 w-4" />,
  questions: <MessageSquareQuote className="h-4 w-4" />,
}

export default function Copilot() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const [history, setHistory] = useState(false)
  const q = useQuery({ queryKey: ['copilot', patient.id, lang], queryFn: () => api.copilot(patient.id, lang) })

  const all = q.data ?? []
  const questions = all.find((a) => a.kind === 'questions' && (a.status === 'done' || a.status === 'kept'))
  const open = all.filter((a) => a.kind !== 'questions' && (a.status === 'proposed' || a.status === 'done'))
  const past = all.filter((a) => !open.includes(a) && a !== questions && a.status !== 'superseded')

  return (
    <div className="space-y-6">
      <PageHeader title={t('copilot.title')} subtitle={t('copilot.subtitle')} />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <QuestionsCard action={questions} />
          <Card>
            <CardHeader icon={<Bot />} title={t('copilot.feed')} subtitle={t('copilot.feed_sub')} />
            {open.length === 0 ? (
              <Empty icon={<Bot className="h-6 w-6" />} title={t('copilot.empty')} body={t('copilot.empty_body')} />
            ) : (
              <ul className="divide-y divide-slate-900/[0.05]">
                {open.map((a) => (
                  <ActionRow key={a.id} a={a} />
                ))}
              </ul>
            )}
          </Card>
          {past.length > 0 && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setHistory((v) => !v)}>
                {history ? t('copilot.hide_history') : t('copilot.show_history', { count: past.length })}
              </Button>
              {history && (
                <Card className="mt-2">
                  <ul className="divide-y divide-slate-900/[0.05]">
                    {past.map((a) => (
                      <ActionRow key={a.id} a={a} />
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ActionRow({ a }: { a: CopilotAction }) {
  const { t } = useTranslation()
  const lang = useLang()
  const refresh = useCareRefresh()
  const m = useMutation({ mutationFn: (d: 'keep' | 'undo' | 'accept' | 'dismiss') => api.decide(a.id, d), onSuccess: refresh })
  const proposed = a.status === 'proposed'
  const statusTone: Record<string, string> = {
    done: 'bg-brand-50 text-brand-800 ring-brand-200',
    proposed: 'bg-amber-100 text-amber-800 ring-amber-200',
    kept: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    accepted: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    rejected: 'bg-slate-100 text-slate-600 ring-slate-200',
    resolved: 'bg-slate-100 text-slate-600 ring-slate-200',
  }
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className={cn('rounded-xl p-2', proposed ? 'bg-amber-50 text-amber-700' : 'bg-brand-50 text-brand-700')}>{KIND_ICON[a.kind]}</span>
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{a.title}</p>
            <Badge className={statusTone[a.status]}>{t(`copilot.status_${a.status}`)}</Badge>
          </div>
          {a.detail && <p className="mt-0.5 text-sm text-slate-600">{a.detail}</p>}
          {a.items.length > 0 && a.kind !== 'test_due' && a.kind !== 'overdue' && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {a.items.map((it, i) => (
                <li key={i} className="rounded-lg bg-white/70 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-900/[0.08] dark:bg-white/[0.04]">
                  <span className="font-medium">{it.label}</span>
                  {it.detail && <span className="text-slate-500"> · {it.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-slate-400">
            {fmtDate(a.created_at, lang)}
            {a.document_id && (
              <>
                {' · '}
                <Link to={`/documents/${a.document_id}`} className="text-brand-700 hover:underline">
                  {t('copilot.source_record')}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.status === 'done' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => m.mutate('keep')} loading={m.isPending && m.variables === 'keep'}>
                <Check className="h-4 w-4" />
                {t('copilot.keep')}
              </Button>
              {(a.kind === 'reminders' || a.kind === 'appointment') && (
                <Link to="/reminders">
                  <Button size="sm" variant="ghost">
                    <Pencil className="h-3.5 w-3.5" />
                    {t('common.edit')}
                  </Button>
                </Link>
              )}
              <Button size="sm" variant="ghost" onClick={() => m.mutate('undo')} loading={m.isPending && m.variables === 'undo'}>
                <Undo2 className="h-4 w-4" />
                {t('copilot.undo')}
              </Button>
            </>
          )}
          {proposed && (
            <>
              <Button size="sm" onClick={() => m.mutate('accept')} loading={m.isPending && m.variables === 'accept'}>
                <Check className="h-4 w-4" />
                {a.kind === 'overdue' ? t('copilot.mark_done') : t('copilot.add_reminder')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => m.mutate('dismiss')} loading={m.isPending && m.variables === 'dismiss'}>
                <X className="h-4 w-4" />
                {t('copilot.dismiss')}
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function QuestionsCard({ action }: { action?: CopilotAction }) {
  const { t } = useTranslation()
  const refresh = useCareRefresh()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const save = useMutation({
    mutationFn: () => api.decide(action!.id, 'edit', draft.map((label) => ({ label }))),
    onSuccess: async () => {
      await refresh()
      setEditing(false)
    },
  })
  const items = action?.items.map((i) => i.label) ?? []
  return (
    <Card className="overflow-hidden">
      <div className="theme-fixed relative flex flex-wrap items-center justify-between gap-3 overflow-hidden bg-gradient-to-r from-brand-700 via-brand-600 to-sky-600 px-5 py-4 text-white">
        <div className="bg-dots pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex items-center gap-3">
          <span className="rounded-xl bg-white/15 p-2 ring-1 ring-white/25 backdrop-blur">
            <MessageSquareQuote className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-lg font-semibold">{t('copilot.questions_title')}</h3>
            <p className="text-sm text-white/80">{t('copilot.questions_sub')}</p>
          </div>
        </div>
        <div className="relative flex gap-2">
          {action && !editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDraft(items)
                setEditing(true)
              }}
            >
              <Pencil className="h-4 w-4 text-brand-600" />
              {t('common.edit')}
            </Button>
          )}
          <Link to="/visit-sheet">
            <Button variant="secondary" size="sm">
              <Printer className="h-4 w-4 text-brand-600" />
              {t('copilot.print_sheet')}
            </Button>
          </Link>
        </div>
      </div>
      <div className="p-5">
        {!action ? (
          <p className="text-sm text-slate-500">{t('copilot.no_questions')}</p>
        ) : editing ? (
          <div className="space-y-2">
            {draft.map((q, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={q} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button variant="ghost" size="icon" onClick={() => setDraft(draft.filter((_, j) => j !== i))} aria-label={t('common.remove')}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft([...draft, ''])}>
                <Plus className="h-4 w-4" />
                {t('copilot.add_question')}
              </Button>
              <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <ol className="list-decimal space-y-2 pl-5 text-slate-800">
            {items.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}
