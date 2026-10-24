import { useQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toLang } from '@/i18n'
import { api } from './api'
import { useAuth } from './auth'
import type { Lang, Patient } from './types'

interface PatientCtx {
  patients: Patient[]
  patient: Patient | null
  loading: boolean
  error: unknown
  select: (id: string) => void
}

const Ctx = createContext<PatientCtx | null>(null)

/** Profiles of the signed-in account; render only after sign-in. */
export function PatientProvider({ children }: { children: ReactNode }) {
  const { account } = useAuth()
  const KEY = `hc.patient.${account?.id}`
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(KEY))
  const q = useQuery({ queryKey: ['patients'], queryFn: api.patients })
  const patients = useMemo(() => q.data ?? [], [q.data])
  const patient = patients.find((p) => p.id === selected) ?? patients.find((p) => p.relationship === 'self') ?? patients[0] ?? null

  const select = useCallback(
    (id: string) => {
      localStorage.setItem(KEY, id)
      setSelected(id)
    },
    [KEY],
  )

  return (
    <Ctx.Provider value={{ patients, patient, loading: q.isLoading, error: q.error, select }}>{children}</Ctx.Provider>
  )
}

export function usePatient() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePatient outside PatientProvider')
  return ctx
}

/** The active patient; only call inside routes rendered after onboarding. */
export function useActivePatient(): Patient {
  const { patient } = usePatient()
  if (!patient) throw new Error('no active patient')
  return patient
}

export function useLang(): Lang {
  const { i18n } = useTranslation()
  return toLang(i18n.resolvedLanguage ?? i18n.language)
}
