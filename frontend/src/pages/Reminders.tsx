import { useMutation, useQuery } from '@tanstack/react-query'
import { Bot, CalendarCheck, CalendarPlus, ChevronLeft, ChevronRight, FlaskConical, Pause, Pencil, Pill, Play, Plus, Square, Stethoscope, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DoseRow, PushToggle, SLOT_ICON, useCareRefresh } from '@/components/care'
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Label, PageHeader, Select, Spinner, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { Appointment, Dose, Reminder } from '@/lib/types'
import { cn, fmtDate } from '@/lib/utils'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return iso(d)
}

export default function Reminders() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const [day, setDay] = useState(iso(new Date()))
  const [who, setWho] = useState<'family' | 'one'>('family')
  const today = useQuery({ queryKey: ['today', day], queryFn: () => api.today(day), refetchInterval: 60_000 })

  const doses = (today.data?.doses ?? []).filter((d) => who === 'family' || d.patient_id === patient.id)
  const appts = (today.data?.appointments ?? []).filter((a) => who === 'family' || a.patient_id === patient.id)
  const isToday = day === iso(new Date())
  const done = doses.filter((d) => d.status === 'taken').length

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('rem.title')}
        subtitle={t('rem.subtitle')}
        action={<PushToggle />}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.06] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setDay(shift(day, -1))} aria-label={t('rem.prev_day')}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-36 text-center">
              <p className="font-semibold text-slate-900">{isToday ? t('rem.today') : fmtDate(day, lang, { weekday: 'long' })}</p>
              <p className="text-xs text-slate-500">{fmtDate(day, lang)}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setDay(shift(day, 1))} aria-label={t('rem.next_day')}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {!isToday && (
              <Button variant="ghost" size="sm" onClick={() => setDay(iso(new Date()))}>
                {t('rem.today')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {doses.length > 0 && (
              <span className="text-sm text-slate-600">{t('rem.progress', { done, total: doses.length })}</span>
            )}
            <Tabs
              value={who}
              onChange={setWho}
              items={[
                { value: 'family', label: t('rem.whole_family') },
                { value: 'one', label: patient.name.split(' ')[0] },
              ]}
            />
          </div>
        </div>
        {today.isLoading ? (
          <Spinner />
        ) : today.error ? (
          <div className="p-5">
            <ErrorNote error={today.error} onRetry={() => today.refetch()} />
          </div>
        ) : doses.length === 0 ? (
          <Empty icon={<Pill className="h-6 w-6" />} title={t('rem.no_doses')} body={t('rem.no_doses_body')} />
        ) : (
          <SlotGroups doses={doses} showPatient={who === 'family'} />
        )}
      </Card>

      <AppointmentsCard appts={appts} />

      <Schedules />
    </div>
  )
}

function SlotGroups({ doses, showPatient }: { doses: Dose[]; showPatient: boolean }) {
  const { t } = useTranslation()
  return (
    <div>
      {(['morning', 'afternoon', 'night'] as const).map((slot) => {
        const list = doses.filter((d) => d.slot === slot)
        if (!list.length) return null
        const Icon = SLOT_ICON[slot]
        return (
          <section key={slot}>
            <h3 className="flex items-center gap-2 bg-slate-50/70 px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase sm:px-5 dark:bg-white/[0.03]">
              <Icon className="h-3.5 w-3.5" />
              {t(`schedule.${slot}`)}
            </h3>
            <ul className="divide-y divide-slate-900/[0.05]">
              {list.map((d) => (
                <DoseRow key={`${d.reminder_id}${d.time}`} d={d} showPatient={showPatient} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function AppointmentsCard({ appts }: { appts: Appointment[] }) {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const refresh = useCareRefresh()
  const [adding, setAdding] = useState(false)
  const done = useMutation({ mutationFn: (a: Appointment) => api.updateAppointment(a.id, { status: 'done' }), onSuccess: refresh })
  const today = iso(new Date())
  return (
    <Card>
      <CardHeader
        icon={<CalendarCheck />}
        title={t('rem.appointments')}
        subtitle={t('rem.appointments_sub')}
        action={
          <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
            <CalendarPlus className="h-4 w-4" />
            {t('rem.add_appointment')}
          </Button>
        }
      />
      {adding && <AppointmentForm onDone={() => setAdding(false)} patientId={patient.id} />}
      {appts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">{t('rem.no_appointments')}</p>
      ) : (
        <ul className="divide-y divide-slate-900/[0.05]">
          {appts.map((a) => {
            const overdue = a.due_date < today
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <span className={cn('rounded-xl p-2', a.kind === 'test' ? 'bg-sky-50 text-sky-700' : 'bg-brand-50 text-brand-700')}>
                  {a.kind === 'test' ? <FlaskConical className="h-4 w-4" /> : <Stethoscope className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-[1_1_14rem]">
                  <p className="font-medium text-slate-900">{a.title}</p>
                  <p className="text-sm text-slate-500">
                    {fmtDate(a.due_date, lang)}
                    {a.time && ` · ${a.time}`}
                    {a.patient_name && ` · ${a.patient_name.split(' ')[0]}`}
                    {a.source_text && <span className="italic"> · “{a.source_text}”</span>}
                  </p>
                </div>
                {overdue ? <Badge className="bg-rose-100 text-rose-800 ring-rose-200">{t('care.status_overdue')}</Badge> : <Badge>{t('rem.upcoming')}</Badge>}
                {a.source === 'copilot' && (
                  <Badge className="bg-brand-50 text-brand-700 ring-brand-200">
                    <Bot className="h-3 w-3" />
                    {t('rem.by_copilot')}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => done.mutate(a)} loading={done.isPending && done.variables?.id === a.id}>
                  {t('rem.mark_done')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function AppointmentForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const refresh = useCareRefresh()
  const [f, setF] = useState({ kind: 'visit' as 'visit' | 'test', title: '', due_date: iso(new Date()), time: '', doctor: '' })
  const save = useMutation({
    mutationFn: () => api.createAppointment(patientId, { ...f, time: f.time || null, doctor: f.doctor || null }),
    onSuccess: async () => {
      await refresh()
      onDone()
    },
  })
  return (
    <form
      className="grid grid-cols-1 gap-3 border-b border-slate-900/[0.06] bg-slate-50/50 px-4 py-4 sm:grid-cols-5 sm:px-5 dark:bg-white/[0.02]"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div>
        <Label>{t('rem.kind')}</Label>
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'visit' | 'test' })}>
          <option value="visit">{t('rem.kind_visit')}</option>
          <option value="test">{t('rem.kind_test')}</option>
        </Select>
      </div>
      <div className="sm:col-span-2">
        <Label>{t('rem.what')}</Label>
        <Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t('rem.what_placeholder')} />
      </div>
      <div>
        <Label>{t('rem.date')}</Label>
        <Input type="date" required value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
      </div>
      <div>
        <Label>{t('rem.time_optional')}</Label>
        <Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
      </div>
      <div className="flex items-center gap-2 sm:col-span-5">
        <Button type="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      </div>
    </form>
  )
}

function Schedules() {
  const { t } = useTranslation()
  const patient = useActivePatient()
  const [tab, setTab] = useState<'active' | 'ended'>('active')
  const [adding, setAdding] = useState(false)
  const q = useQuery({ queryKey: ['reminders', patient.id], queryFn: () => api.reminders(patient.id) })
  const all = q.data?.reminders ?? []
  const list = all.filter((r) => (tab === 'active' ? r.status !== 'ended' : r.status === 'ended'))
  const adh = q.data?.adherence
  return (
    <Card>
      <CardHeader
        icon={<Pill />}
        title={t('rem.schedules', { name: patient.name.split(' ')[0] })}
        subtitle={
          adh?.percent != null ? t('rem.adherence', { percent: adh.percent, taken: adh.taken, scheduled: adh.scheduled }) : t('rem.schedules_sub')
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'active', label: t('meds.active') },
                { value: 'ended', label: t('rem.ended') },
              ]}
            />
            <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus className="h-4 w-4" />
              {t('rem.add_reminder')}
            </Button>
          </div>
        }
      />
      {adding && <ReminderEditor patientId={patient.id} onDone={() => setAdding(false)} />}
      {q.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">{tab === 'active' ? t('rem.no_schedules') : t('rem.no_ended')}</p>
      ) : (
        <ul className="divide-y divide-slate-900/[0.05]">
          {list.map((r) => (
            <ScheduleRow key={r.id} r={r} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ScheduleRow({ r }: { r: Reminder }) {
  const { t } = useTranslation()
  const lang = useLang()
  const refresh = useCareRefresh()
  const [editing, setEditing] = useState(false)
  const patch = useMutation({ mutationFn: (status: 'active' | 'paused' | 'ended') => api.updateReminder(r.id, { status }), onSuccess: refresh })
  const del = useMutation({ mutationFn: () => api.deleteReminder(r.id), onSuccess: refresh })
  if (editing) return <ReminderEditor reminder={r} patientId={r.patient_id} onDone={() => setEditing(false)} />
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900">
          {r.title}
          {r.source === 'copilot' ? (
            <Badge className="bg-brand-50 text-brand-700 ring-brand-200">
              <Bot className="h-3 w-3" />
              {t('rem.by_copilot')}
            </Badge>
          ) : (
            <Badge>{t('rem.by_you')}</Badge>
          )}
          {r.status === 'paused' && <Badge className="bg-amber-100 text-amber-800 ring-amber-200">{t('rem.paused')}</Badge>}
        </p>
        <p className="mt-0.5 text-sm text-slate-500">
          {r.slots.map((s) => s.time).join(' · ')}
          {r.detail && ` · ${t(`rem.meal.${r.detail}`, { defaultValue: r.detail })}`}
          {' · '}
          {r.end_date ? t('rem.until', { date: fmtDate(r.end_date, lang) }) : t('schedule.ongoing')}
        </p>
      </div>
      {r.status !== 'ended' && (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" />
            {t('common.edit')}
          </Button>
          {r.status === 'paused' ? (
            <Button variant="ghost" size="sm" onClick={() => patch.mutate('active')}>
              <Play className="h-3.5 w-3.5" />
              {t('rem.resume')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => patch.mutate('paused')}>
              <Pause className="h-3.5 w-3.5" />
              {t('rem.pause')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => confirm(t('rem.stop_confirm')) && patch.mutate('ended')}>
            <Square className="h-3.5 w-3.5" />
            {t('rem.stop')}
          </Button>
        </div>
      )}
      <Button variant="ghost" size="icon" onClick={() => confirm(t('rem.delete_confirm')) && del.mutate()} aria-label={t('common.delete')}>
        <Trash2 className="h-4 w-4 text-slate-400" />
      </Button>
    </li>
  )
}

function ReminderEditor({ reminder, patientId, onDone }: { reminder?: Reminder; patientId: string; onDone: () => void }) {
  const { t } = useTranslation()
  const refresh = useCareRefresh()
  const [title, setTitle] = useState(reminder?.title ?? '')
  const [detail, setDetail] = useState(reminder?.detail ?? '')
  const [slots, setSlots] = useState(reminder?.slots.map((s) => ({ time: s.time, amount: s.amount })) ?? [{ time: '08:00', amount: '' }])
  const [end, setEnd] = useState(reminder?.end_date ?? '')
  const save = useMutation({
    mutationFn: () =>
      reminder
        ? api.updateReminder(reminder.id, { title, detail, slots, ...(end ? { end_date: end } : { clear_end_date: true }) })
        : api.createReminder(patientId, { title, detail, slots, end_date: end || null }),
    onSuccess: async () => {
      await refresh()
      onDone()
    },
  })
  return (
    <li className="list-none">
      <form
        className="space-y-3 bg-slate-50/50 px-4 py-4 sm:px-5 dark:bg-white/[0.02]"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Label>{t('rem.medicine_name')}</Label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Vitamin D3 60K" />
          </div>
          <div>
            <Label>{t('rem.last_day')}</Label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>{t('rem.how')}</Label>
          <Input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={t('rem.how_placeholder')} />
        </div>
        <div>
          <Label hint={t('rem.times_hint')}>{t('rem.times')}</Label>
          <div className="flex flex-wrap gap-2">
            {slots.map((s, i) => (
              <div key={i} className="flex items-center gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-900/[0.08] dark:bg-white/[0.04]">
                <Input type="time" required className="h-8 w-28" value={s.time} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
                <Input className="h-8 w-28" value={s.amount} placeholder="1 tablet" onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                {slots.length > 1 && (
                  <button type="button" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" onClick={() => setSlots(slots.filter((_, j) => j !== i))} aria-label={t('common.remove')}>
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => setSlots([...slots, { time: '21:00', amount: slots[0]?.amount ?? '' }])}>
              <Plus className="h-4 w-4" />
              {t('rem.add_time')}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
          {reminder?.medication_id && (
            <Link to="/medications" className="ml-auto text-sm text-brand-700 hover:underline">
              {t('rem.from_prescription')}
            </Link>
          )}
        </div>
      </form>
    </li>
  )
}
