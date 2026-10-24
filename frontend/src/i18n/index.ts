import i18n, { type BackendModule, type ResourceKey } from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import type { Lang } from '@/lib/types'
import en from './en.json'

// Ordered by number of speakers in India (Census 2011), English first.
export const LANGUAGES: { code: Lang; label: string; english: string }[] = [
  { code: 'en', label: 'English', english: 'English' },
  { code: 'hi', label: 'हिन्दी', english: 'Hindi' },
  { code: 'bn', label: 'বাংলা', english: 'Bengali' },
  { code: 'mr', label: 'मराठी', english: 'Marathi' },
  { code: 'te', label: 'తెలుగు', english: 'Telugu' },
  { code: 'ta', label: 'தமிழ்', english: 'Tamil' },
  { code: 'gu', label: 'ગુજરાતી', english: 'Gujarati' },
  { code: 'ur', label: 'اردو', english: 'Urdu' },
  { code: 'kn', label: 'ಕನ್ನಡ', english: 'Kannada' },
  { code: 'or', label: 'ଓଡ଼ିଆ', english: 'Odia' },
  { code: 'ml', label: 'മലയാളം', english: 'Malayalam' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ', english: 'Punjabi' },
  { code: 'as', label: 'অসমীয়া', english: 'Assamese' },
]

export const SUPPORTED = LANGUAGES.map((l) => l.code)
const RTL = new Set<string>(['ur'])

export const toLang = (l: string | null | undefined): Lang => {
  const code = (l ?? 'en').slice(0, 2) as Lang
  return SUPPORTED.includes(code) ? code : 'en'
}

// English ships in the main bundle; every other language is a separate chunk fetched when it is first used.
const bundles = import.meta.glob<{ default: ResourceKey }>(['./*.json', '!./en.json'])
const lazyBundles: BackendModule = {
  type: 'backend',
  init() {},
  read(lng, _ns, done) {
    const load = bundles[`./${lng}.json`]
    if (!load) return done(null, {})
    load().then(
      (m) => done(null, m.default),
      (e: Error) => done(e, null),
    )
  },
}

i18n
  .use(lazyBundles)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED,
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    detection: { order: ['querystring', 'localStorage', 'navigator'], lookupQuerystring: 'lng', lookupLocalStorage: 'hc.lang', caches: ['localStorage'] },
  })

function applyDocumentLang(lng: string) {
  const code = toLang(lng)
  document.documentElement.lang = code
  document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr'
}

i18n.on('languageChanged', applyDocumentLang)
applyDocumentLang(i18n.resolvedLanguage ?? i18n.language ?? 'en')

export function currentLang(): Lang {
  return toLang(i18n.resolvedLanguage ?? i18n.language)
}

export default i18n
