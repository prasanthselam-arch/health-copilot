import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ErrorNote, Button, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import { fmtDate } from '@/lib/utils'

/** A one-page, printable sheet to take to the next doctor visit. */
export default function VisitSheet() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const q = useQuery({ queryKey: ['visitPrep', patient.id, lang], queryFn: () => api.visitPrep(patient.id, lang) })
  if (q.isLoading) return <Spinner label={t('common.loading')} />
  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />
  const v = q.data!
  const gender = v.patient.gender ? t(`onboarding.${v.patient.gender}`, { defaultValue: v.patient.gender }) : null
  return (
    <div className="min-h-full bg-white text-slate-900">
      <div className="mx-auto max-w-3xl px-6 py-8 print:p-0">
        <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
          <Link to="/copilot" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-4 w-4" />
            {t('copilot.title')}
          </Link>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            {t('copilot.print')}
          </Button>
        </div>
        <header className="border-b-2 border-slate-900 pb-3">
          <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase">{t('copilot.sheet_title')}</p>
          <h1 className="text-2xl font-bold">{v.patient.name}</h1>
          <p className="text-sm text-slate-600">
            {[v.patient.age != null && t('copilot.age', { age: v.patient.age }), gender, v.patient.conditions.join(', ')].filter(Boolean).join(' · ')}
          </p>
          <p className="text-xs text-slate-500">
            {t('copilot.prepared_on', { date: fmtDate(v.generated_on, lang) })}
            {v.adherence.percent != null && ` · ${t('copilot.adherence_line', { percent: v.adherence.percent })}`}
          </p>
        </header>

        <Section title={t('copilot.questions_title')}>
          <ol className="list-decimal space-y-1.5 pl-5">
            {v.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Section>

        <Section title={t('copilot.current_meds')}>
          {v.medications.length === 0 ? (
            <p className="text-sm text-slate-500">{t('dashboard.meds_empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {v.medications.map((m) => (
                  <tr key={m.id} className="border-b border-slate-200">
                    <td className="py-1.5 pr-3 font-medium">
                      {m.name} {m.strength}
                    </td>
                    <td className="py-1.5 pr-3">{m.schedule}</td>
                    <td className="py-1.5 text-slate-600">{m.meal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {v.insights.length > 0 && (
          <Section title={t('copilot.to_discuss')}>
            <ul className="space-y-2">
              {v.insights.map((i) => (
                <li key={i.key}>
                  <p className="font-medium">{i.title}</p>
                  <p className="text-sm text-slate-700">{i.body}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {v.due.length > 0 && (
          <Section title={t('copilot.tests_due')}>
            <ul className="space-y-1 text-sm">
              {v.due.map((d) => (
                <li key={d.key}>
                  <span className="font-medium">{d.title}</span>
                  {d.due_date && ` · ${t(`care.status_${d.status}`)} (${fmtDate(d.due_date, lang)})`}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title={t('copilot.notes')}>
          <div className="h-28 rounded border border-dashed border-slate-300" />
        </Section>
        <p className="mt-6 text-xs text-slate-500">{v.disclaimer}</p>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 break-inside-avoid">
      <h2 className="mb-2 text-sm font-bold tracking-wide text-slate-700 uppercase">{title}</h2>
      {children}
    </section>
  )
}
