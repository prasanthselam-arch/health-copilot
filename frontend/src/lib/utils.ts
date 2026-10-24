import { clsx, type ClassValue } from 'clsx'
import type { TFunction } from 'i18next'
import { twMerge } from 'tailwind-merge'
import type { Flag, Lang, Patient } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "Mother", or the user's own word for an "other" relationship. */
export function relationshipLabel(p: Pick<Patient, 'relationship' | 'relationship_other'>, t: TFunction) {
  if (!p.relationship) return ''
  return p.relationship === 'other' && p.relationship_other ? p.relationship_other : t(`relationship.${p.relationship}`)
}

const LOCALE: Record<Lang, string> = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', te: 'te-IN', ta: 'ta-IN', gu: 'gu-IN',
  ur: 'ur-IN', kn: 'kn-IN', or: 'or-IN', ml: 'ml-IN', pa: 'pa-IN', as: 'as-IN',
}

export function fmtDate(iso: string | null | undefined, lang: Lang = 'en', opts?: Intl.DateTimeFormatOptions) {
  if (!iso) return ''
  // The API stores times in UTC but returns them without a zone.
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : /T[\d:.]+$/.test(iso) ? iso + 'Z' : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(LOCALE[lang], opts ?? { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtNum(v: number | string | null | undefined) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (Number.isInteger(v)) return String(v)
  return String(Number(Math.abs(v) < 1 ? v.toPrecision(3) : v.toFixed(2))) // keep 0.004, not 0
}

export function rangeText(lo: number | null, hi: number | null) {
  if (lo !== null && hi !== null) return `${fmtNum(lo)} – ${fmtNum(hi)}`
  if (hi !== null) return `≤ ${fmtNum(hi)}`
  if (lo !== null) return `≥ ${fmtNum(lo)}`
  return ''
}

export function isAbnormal(f: Flag) {
  return f !== null && f !== 'N'
}

export const flagTone: Record<string, string> = {
  N: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  L: 'bg-amber-50 text-amber-800 ring-amber-200',
  H: 'bg-amber-50 text-amber-800 ring-amber-200',
  A: 'bg-amber-50 text-amber-800 ring-amber-200',
  LL: 'bg-red-50 text-red-700 ring-red-200',
  HH: 'bg-red-50 text-red-700 ring-red-200',
}

export function confidenceTone(c: number) {
  if (c >= 0.9) return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (c >= 0.75) return 'bg-amber-50 text-amber-800 ring-amber-200'
  return 'bg-red-50 text-red-700 ring-red-200'
}

export function ageOf(birth: string | null): number | null {
  if (!birth) return null
  const b = new Date(birth + 'T00:00:00')
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--
  return age >= 0 ? age : null
}

/** A complete 6-digit email code. */
export const codeComplete = (code: string) => /^\d{6}$/.test(code)
