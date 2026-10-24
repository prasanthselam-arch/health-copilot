import {
  BellRing,
  Bot,
  CalendarClock,
  HeartPulse,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Languages,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  LogOut,
  MessageCircleHeart,
  Moon,
  Pill,
  ShieldCheck,
  Sun,
  Upload,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LANGUAGES } from '@/i18n'
import { useAuth } from '@/lib/auth'
import { useLang, usePatient } from '@/lib/patient'
import { cn, relationshipLabel } from '@/lib/utils'
import { formatPhone } from '@/lib/phone'
import { Avatar } from './Avatar'
import { ThemeToggle } from './ThemeToggle'
import { useTheme } from '@/lib/theme'
import { Disclaimer } from './medical'
import { ConfirmDialog, Spinner } from './ui'
import { DueDoseToast } from './care'

const NAV_GROUPS = [
  {
    key: 'records',
    items: [
      { to: '/', key: 'dashboard', icon: LayoutDashboard },
      { to: '/upload', key: 'upload', icon: Upload },
      { to: '/timeline', key: 'timeline', icon: CalendarClock },
      { to: '/trends', key: 'trends', icon: LineChart },
      { to: '/medications', key: 'medications', icon: Pill },
    ],
  },
  {
    key: 'care',
    items: [
      { to: '/reminders', key: 'reminders', icon: BellRing },
      { to: '/insights', key: 'insights', icon: HeartPulse },
      { to: '/copilot', key: 'copilot', icon: Bot },
    ],
  },
  {
    key: 'assist',
    items: [
      { to: '/chat', key: 'chat', icon: MessageCircleHeart },
      { to: '/abha', key: 'abha', icon: ShieldCheck },
      { to: '/profiles', key: 'profiles', icon: Users },
    ],
  },
]
const NAV = NAV_GROUPS.flatMap((g) => g.items)

export function LanguageSwitcher({ className, tone = 'light' }: { className?: string; tone?: 'light' | 'dark' }) {
  const { i18n, t } = useTranslation()
  const lang = useLang()
  const dark = tone === 'dark'
  return (
    <label
      className={cn(
        'flex items-center gap-2 rounded-xl px-2.5 text-sm ring-1 ring-inset transition',
        dark ? 'bg-white/[0.06] ring-white/10 hover:bg-white/10' : 'bg-white ring-slate-900/[0.08] shadow-[var(--shadow-soft)]',
        className,
      )}
    >
      <Languages className={cn('h-4 w-4 shrink-0', dark ? 'text-brand-300' : 'text-brand-600')} />
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={lang}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
        className={cn(
          'w-full cursor-pointer border-0 bg-transparent py-1.5 pr-7 pl-0 text-sm focus:ring-0 [&_option]:text-slate-900',
          dark ? 'text-slate-100' : 'text-slate-700',
        )}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
            {l.code !== 'en' ? ` · ${l.english}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

function PatientSwitcher() {
  const { t } = useTranslation()
  const { patients, patient, select } = usePatient()
  if (!patient) return null
  const index = patients.findIndex((p) => p.id === patient.id)
  const label = (p: typeof patient) => (p.relationship ? `${p.name} · ${relationshipLabel(p, t)}` : p.name)
  return (
    <div className="relative rounded-2xl bg-gradient-to-br from-white/[0.09] to-white/[0.03] p-3 ring-1 ring-inset ring-white/10">
      <div className="flex items-center gap-3">
        <Avatar name={patient.name} index={index} className="h-10 w-10 text-sm ring-2 ring-white/15" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{patient.name}</p>
          <p className="truncate text-xs text-slate-400">
            {patient.abha_address ? (
              <span className="inline-flex items-center gap-1 text-brand-300">
                <ShieldCheck className="h-3 w-3" />
                {patient.abha_address}
              </span>
            ) : (
              [relationshipLabel(patient, t), formatPhone(patient.phone)].filter(Boolean).join(' · ') ||
              t('profiles.viewing')
            )}
          </p>
        </div>
        {patients.length > 1 && <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />}
      </div>
      {patients.length > 1 && (
        <select
          aria-label={t('profiles.family')}
          value={patient.id}
          onChange={(e) => select(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0 [&_option]:text-slate-900"
        >
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** Language as an icon plus its code, over a native select, for the narrow phone header. */
function CompactLanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const lang = useLang()
  return (
    <label className="relative flex h-10 shrink-0 items-center gap-1 rounded-xl bg-white px-2.5 text-xs font-semibold text-slate-700 uppercase shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.08]">
      <Languages className="h-4 w-4 text-brand-600" />
      {lang}
      <select
        aria-label={t('common.language')}
        value={lang}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0 [&_option]:text-slate-900"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
            {l.code !== 'en' ? ` · ${l.english}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

const TAB_BAR = [
  { to: '/', label: 'nav.short_home', icon: LayoutDashboard },
  { to: '/reminders', label: 'nav.short_reminders', icon: BellRing },
  { to: '/upload', label: 'nav.upload', icon: Upload },
  { to: '/chat', label: 'nav.short_chat', icon: MessageCircleHeart },
]
const IN_MORE = NAV.filter((n) => !TAB_BAR.some((b) => b.to === n.to))

/** Phone navigation: four tabs with a raised upload button, and "More" for the rest. */
function MobileTabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const { t } = useTranslation()
  const location = useLocation()
  const inMore = IN_MORE.some((n) => location.pathname.startsWith(n.to))
  const tab = 'flex min-w-0 flex-col items-center justify-end gap-1 pt-2 pb-1.5 text-[11px] font-medium transition-colors'
  return (
    <nav
      aria-label={t('nav.group_records')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-900/[0.07] bg-white/90 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-12px_rgb(15_23_42/0.18)] backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto grid max-w-lg grid-cols-5 px-1">
        {TAB_BAR.map(({ to, label, icon: Icon }) =>
          to === '/upload' ? (
            <NavLink key={to} to={to} className={cn(tab, 'text-slate-600')}>
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      '-mt-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 via-brand-600 to-brand-800 text-white shadow-[var(--shadow-glow)] ring-4 ring-white transition-transform active:scale-95',
                      isActive && 'scale-105',
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className={cn('max-w-full truncate', isActive && 'text-brand-700')}>{t(label)}</span>
                </>
              )}
            </NavLink>
          ) : (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cn(tab, isActive && !moreOpen ? 'text-brand-700' : 'text-slate-500')}>
              {({ isActive }) => (
                <>
                  <span className={cn('flex h-8 w-12 items-center justify-center rounded-full transition-colors', isActive && !moreOpen && 'bg-brand-50')}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="max-w-full truncate">{t(label)}</span>
                </>
              )}
            </NavLink>
          ),
        )}
        <button type="button" onClick={onMore} aria-expanded={moreOpen} className={cn(tab, inMore || moreOpen ? 'text-brand-700' : 'text-slate-500')}>
          <span className={cn('flex h-8 w-12 items-center justify-center rounded-full transition-colors', (inMore || moreOpen) && 'bg-brand-50')}>
            <LayoutGrid className="h-5 w-5" />
          </span>
          <span className="max-w-full truncate">{t('nav.more')}</span>
        </button>
      </div>
    </nav>
  )
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.more')}>
      <button type="button" aria-label={t('common.close')} onClick={onClose} className="animate-fade-in absolute inset-0 bg-ink-900/40 backdrop-blur-[2px]" />
      <div className="animate-sheet-up absolute inset-x-0 bottom-0 rounded-t-3xl bg-white px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-lift)]">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-slate-200" />
        <div className="mb-4 flex items-center justify-between">
          <p className="font-display text-lg font-bold text-slate-900">{t('nav.more')}</p>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {IN_MORE.map(({ to, key, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-2xl p-3.5 text-sm font-medium ring-1 ring-inset transition-colors',
                  isActive ? 'bg-brand-50 text-brand-800 ring-brand-200' : 'bg-slate-50 text-slate-700 ring-slate-900/[0.05] active:bg-slate-100',
                )
              }
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-brand-600 shadow-[var(--shadow-soft)]">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 leading-snug">{t(`nav.${key}`)}</span>
            </NavLink>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2.5">
          <LanguageSwitcher className="h-10 flex-1" />
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}

/** Name chip in the top-right corner that opens the account menu. On phones it shows the family member being viewed,
 *  and the menu switches between them (the sidebar does that on desktop). */
function AccountMenu({ phone = false }: { phone?: boolean }) {
  const { t } = useTranslation()
  const { account, signOut } = useAuth()
  const { patients, patient, select } = usePatient()
  const { theme, toggle } = useTheme()
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const stay = useCallback(() => setAsking(false), [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!account) return null
  const login = account.login.startsWith('+') ? formatPhone(account.login) : account.login
  const item = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors'
  const close = () => setOpen(false)
  const shown = phone && patient ? patient : account
  const shownIndex = phone && patient ? patients.findIndex((p) => p.id === patient.id) : 0
  const switchable = phone && patients.length > 1
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('account.menu')}: ${shown.name}`}
        title={t('account.menu')}
        className={cn(
          'inline-flex h-10 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-xl bg-white pr-2 pl-1.5 text-slate-800 shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.08] transition hover:ring-slate-900/[0.16] focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none active:scale-95',
          open && 'ring-brand-300',
        )}
      >
        <Avatar name={shown.name} index={shownIndex} className="h-7 w-7 shrink-0 text-[11px]" />
        <span className={cn('min-w-0 truncate text-sm font-semibold', phone && 'hidden min-[430px]:block')}>{shown.name.split(' ')[0]}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="menu" className="animate-fade-up absolute top-12 right-0 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-[var(--shadow-lift)] ring-1 ring-slate-900/[0.08]">
          <div className="flex items-center gap-3 px-3 pt-2 pb-3">
            <Avatar name={account.name} index={0} className="h-10 w-10 text-sm" />
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-900">{account.name}</p>
              <p className="truncate text-xs text-slate-500">{account.email ?? login}</p>
            </div>
          </div>
          {switchable && (
            <div className="border-t border-slate-100 py-2">
              <p className="px-3 pb-1 text-[11px] font-semibold tracking-[0.12em] text-slate-400 uppercase">{t('profiles.viewing')}</p>
              <div className="scrollbar-thin max-h-56 space-y-0.5 overflow-y-auto">
                {patients.map((p, i) => (
                  <button
                    key={p.id}
                    role="menuitemradio"
                    aria-checked={p.id === patient?.id}
                    type="button"
                    onClick={() => {
                      select(p.id)
                      close()
                    }}
                    className={cn(item, 'py-2', p.id === patient?.id ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-50')}
                  >
                    <Avatar name={p.name} index={i} className="h-7 w-7 shrink-0 text-[11px]" />
                    <span className="min-w-0 flex-1 truncate">
                      {p.name}
                      {p.relationship && <span className="text-slate-400"> · {relationshipLabel(p, t)}</span>}
                    </span>
                    {p.id === patient?.id && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-0.5 border-t border-slate-100 pt-2">
            <NavLink
              role="menuitem"
              to="/account"
              onClick={close}
              className={({ isActive }) => cn(item, isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-50')}
            >
              <UserCog className="h-[18px] w-[18px] text-brand-600" />
              {t('nav.account')}
            </NavLink>
            <button role="menuitem" type="button" onClick={toggle} className={cn(item, 'text-slate-700 hover:bg-slate-50 lg:hidden')}>
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px] text-amber-600" /> : <Moon className="h-[18px] w-[18px] text-indigo-600" />}
              {t(theme === 'dark' ? 'theme.to_light' : 'theme.to_dark')}
            </button>
          </div>
          <div className="mt-1 border-t border-slate-100 pt-1">
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false)
                setAsking(true)
              }}
              className={cn(item, 'text-red-600 hover:bg-red-50')}
            >
              <LogOut className="h-[18px] w-[18px]" />
              {t('auth.sign_out')}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={asking}
        icon={<LogOut className="h-6 w-6" />}
        title={t('auth.sign_out_title')}
        body={t('auth.sign_out_body')}
        confirmLabel={t('auth.sign_out')}
        busy={leaving}
        onCancel={stay}
        onConfirm={() => {
          setLeaving(true)
          void signOut().finally(() => setLeaving(false))
        }}
      />
    </div>
  )
}

export function Layout() {
  const { t } = useTranslation()
  const location = useLocation()
  const { patient } = usePatient()
  const [more, setMore] = useState(false)
  const closeMore = useCallback(() => setMore(false), [])
  return (
    <div className="flex min-h-full">
      <aside className="theme-fixed sticky top-0 hidden h-screen w-[17rem] shrink-0 flex-col overflow-hidden bg-ink-900 px-4 py-5 text-slate-300 lg:flex">
        {/* soft brand glows behind the sidebar content */}
        <div className="pointer-events-none absolute -top-24 -left-16 h-64 w-64 rounded-full bg-brand-500/25 blur-3xl" />
        <div className="pointer-events-none absolute bottom-10 -right-24 h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Brand tone="dark" />
          <nav className="scrollbar-thin mt-7 flex-1 space-y-6 overflow-y-auto pr-1">
            {NAV_GROUPS.map((g) => (
              <div key={g.key}>
                <p className="mb-2 px-3 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">{t(`nav.group_${g.key}`)}</p>
                <div className="space-y-0.5">
                  {g.items.map(({ to, key, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={to === '/'}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                          isActive
                            ? 'bg-gradient-to-r from-brand-500/25 via-brand-500/10 to-transparent text-white shadow-[inset_0_0_0_1px_rgb(69_194_165/0.25)]'
                            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute top-2 bottom-2 left-0 w-1 rounded-r-full bg-brand-400 shadow-[0_0_12px_rgb(69_194_165/0.8)]" />}
                          <Icon className={cn('h-[18px] w-[18px] transition-colors', isActive ? 'text-brand-300' : 'text-slate-500 group-hover:text-slate-300')} />
                          {t(`nav.${key}`)}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="space-y-3 border-t border-white/[0.07] pt-4">
            <LanguageSwitcher tone="dark" />
            <PatientSwitcher />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-[calc(4.25rem+env(safe-area-inset-bottom))] lg:pb-0">
        <header className="sticky top-0 z-20 border-b border-slate-900/[0.06] bg-white/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl lg:hidden">
          <div className="flex h-14 items-center justify-between gap-2 px-4">
            <Brand compact />
            <div className="flex items-center gap-1.5">
              <CompactLanguageSwitcher />
              <AccountMenu phone />
            </div>
          </div>
        </header>

        <div className="relative z-20 hidden h-16 items-center justify-end gap-2 px-10 lg:flex">
          <ThemeToggle />
          <AccountMenu />
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:pt-1 lg:pb-9">
          <Suspense fallback={<Spinner label={t('common.loading')} />}>
            {/* remount on profile switch so chat history, ABHA transactions and drafts never carry over to another person */}
            <div key={`${patient?.id}:${location.pathname}`} className="animate-fade-up">
              <Outlet />
            </div>
          </Suspense>
        </main>

        <footer className="border-t border-slate-900/[0.06] bg-white/60 px-4 py-3 backdrop-blur sm:px-6 lg:px-10">
          <Disclaimer className="mx-auto max-w-7xl" />
        </footer>
      </div>
      <MobileTabBar onMore={() => setMore((m) => !m)} moreOpen={more} />
      {more && <MoreSheet onClose={closeMore} />}
      {location.pathname !== '/reminders' && <DueDoseToast />}
    </div>
  )
}

/** Heart with a sweeping ECG trace; still when the user prefers reduced motion. */
export function Logo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'hc-logo relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 via-brand-600 to-brand-800 text-white shadow-[var(--shadow-glow),inset_0_1px_0_rgb(255_255_255/0.3)]',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none" aria-hidden="true">
        <path
          className="hc-logo-heart"
          d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.9 4 7.4 4c2 0 3.5 1.1 4.6 2.7C13.1 5.1 14.6 4 16.6 4c3.5 0 5.8 3.6 4.6 7.1-1.7 4.8-9.2 9.4-9.2 9.4Z"
          fill="rgb(255 255 255 / 0.18)"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          className="hc-logo-trace"
          pathLength={100}
          d="M2.5 12.5h5l1.6-3.2 2.4 6.4 2.1-5.1 1.3 1.9h6.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

export function Brand({ tone = 'light', compact = false }: { tone?: 'light' | 'dark'; compact?: boolean }) {
  const { t } = useTranslation()
  const dark = tone === 'dark'
  return (
    <Link to="/" className={cn('flex min-w-0 items-center rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none', compact ? 'gap-2.5' : 'gap-3')}>
      <Logo className={cn('shrink-0', compact && 'h-9 w-9 sm:h-10 sm:w-10')} />
      <div className="min-w-0 leading-tight">
        <p className={cn('font-display font-bold whitespace-nowrap', compact ? 'text-base sm:text-[1.05rem]' : 'text-[1.05rem]', dark ? 'text-white' : 'text-slate-900')}>
          {t('app.name')}
        </p>
        <p className={cn('text-xs', dark ? 'text-slate-400' : 'text-slate-500', compact && 'hidden sm:block')}>{t('app.tagline')}</p>
      </div>
    </Link>
  )
}
