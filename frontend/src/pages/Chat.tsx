import { useMutation } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUp,
  BookMarked,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  Headphones,
  Info,
  Languages,
  Loader2,
  LineChart,
  MessageCircleHeart,
  Mic,
  Pill,
  SquarePen,
  Square,
  Stethoscope,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatMarkdown } from '@/components/chat/ChatMarkdown'
import { MedicinesCard, ResultsCard, SourceLink } from '@/components/chat/RecordCards'
import { Button, Card, ErrorNote } from '@/components/ui'
import { LANGUAGES } from '@/i18n'
import { api } from '@/lib/api'
import { markdownToText } from '@/lib/markdown'
import { useActivePatient, useLang } from '@/lib/patient'
import { languageName, speak, stopSpeaking, useDictation, useSpeaker } from '@/lib/speech'
import type { ChatReply } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  reply?: ChatReply
  at?: number
  voice?: boolean
}

const SUGGESTIONS = [
  { key: 's1', icon: FlaskConical },
  { key: 's2', icon: Pill },
  { key: 's3', icon: LineChart },
  { key: 's4', icon: Stethoscope },
] as const

const stored = (key: string) => localStorage.getItem(key)
const msgId = (m: Msg, i: number) => `msg-${m.at ?? i}`

export default function Chat() {
  const { t } = useTranslation()
  const lang = useLang()
  const patient = useActivePatient()
  const storeKey = `hc.chat.${patient.id}`
  const [messages, setMessages] = useState<Msg[]>(() => JSON.parse(sessionStorage.getItem(storeKey) ?? '[]'))
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const [audioMode, setAudioMode] = useState(() => stored('hc.chat.audio') === '1')
  // Each person speaks their own language: a parent's profile set to Telugu listens for Telugu.
  const voiceKey = `hc.chat.voiceLang.${patient.id}`
  const [voiceLang, setVoiceLang] = useState(() => stored(voiceKey) ?? patient.preferred_language ?? lang)
  const lastByVoice = useRef(false)
  const audioModeRef = useRef(audioMode)
  useEffect(() => {
    audioModeRef.current = audioMode
    localStorage.setItem('hc.chat.audio', audioMode ? '1' : '0')
    if (!audioMode) stopSpeaking()
  }, [audioMode])
  useEffect(() => localStorage.setItem(voiceKey, voiceLang), [voiceKey, voiceLang])
  useEffect(() => () => stopSpeaking(), [])

  const dictation = useDictation({
    lang: voiceLang,
    onInterim: setInput,
    onFinal: (text) => {
      if (audioModeRef.current) send(text, true)
      else {
        setInput(text)
        lastByVoice.current = true
        box.current?.focus()
      }
    },
  })

  const ask = useMutation({
    mutationFn: ({ text, history, voice }: { text: string; history: Msg[]; voice?: boolean }) =>
      api.chat(
        patient.id,
        text,
        history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
        lang,
        voice,
      ),
    onSuccess: (reply, { voice }) => {
      const at = Date.now()
      setMessages((m) => [...m, { role: 'assistant', content: reply.answer, reply, at }])
      // A spoken question gets a spoken answer, even outside audio mode.
      if (audioModeRef.current || voice)
        void speak(`msg-${at}`, markdownToText(reply.answer), reply.reply_language || lang, () => {
          // Hands-free: after reading the answer to a spoken question, listen for the next one.
          if (audioModeRef.current && lastByVoice.current) dictation.start()
        })
    },
  })

  useEffect(() => {
    sessionStorage.setItem(storeKey, JSON.stringify(messages.slice(-30)))
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, storeKey, ask.isPending])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const send = (text: string, byVoice = false) => {
    const q = text.trim()
    if (!q || ask.isPending) return
    const voice = byVoice || (lastByVoice.current && q === input.trim())
    lastByVoice.current = voice
    stopSpeaking()
    ask.mutate({ text: q, history: messages, voice })
    setMessages((m) => [...m, { role: 'user', content: q, at: Date.now(), voice }])
    setInput('')
  }
  const retry = () => {
    const last = messages[messages.length - 1]
    if (last?.role === 'user') ask.mutate({ text: last.content, history: messages.slice(0, -1), voice: last.voice })
  }
  const newChat = () => {
    stopSpeaking()
    dictation.stop()
    ask.reset()
    setMessages([])
    box.current?.focus()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(input)
  }

  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant')
  const firstName = patient.name.split(' ')[0]

  return (
    <div className="flex h-[calc(100dvh-11rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col lg:h-[calc(100dvh-11rem)]">
      <div className="mb-4 flex items-start justify-between gap-3 lg:mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{t('chat.title')}</h1>
          <p className="mt-1 hidden text-slate-500 sm:block">{t('chat.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={audioMode}
            onClick={() => setAudioMode((v) => !v)}
            title={t('chat.audio_mode_hint')}
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 transition-colors',
              audioMode ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50',
            )}
          >
            <Headphones className="h-4 w-4" />
            <span className="hidden sm:inline">{t('chat.audio_mode')}</span>
            <span className={cn('relative h-4 w-7 rounded-full transition-colors', audioMode ? 'bg-white/30' : 'bg-slate-200')}>
              <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all', audioMode ? 'left-3.5' : 'left-0.5')} />
            </span>
          </button>
          {messages.length > 0 && (
            <Button variant="secondary" size="sm" onClick={newChat} title={t('chat.new_chat')}>
              <SquarePen className="h-4 w-4" />
              <span className="hidden sm:inline">{t('chat.new_chat')}</span>
            </Button>
          )}
        </div>
      </div>
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="scrollbar-thin flex-1 overflow-y-auto bg-gradient-to-b from-slate-50/60 to-white">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center pt-1 text-center sm:pt-12">
                <div className="hc-logo rounded-2xl bg-gradient-to-br from-brand-400 via-brand-600 to-brand-800 p-3 text-white shadow-[var(--shadow-glow)] sm:p-4">
                  <MessageCircleHeart className="h-6 w-6 sm:h-7 sm:w-7" />
                </div>
                <h2 className="mt-4 text-xl font-bold tracking-tight text-slate-900 sm:mt-5 sm:text-2xl">{t('chat.greeting', { name: firstName })}</h2>
                <p className="mt-1.5 max-w-md text-sm text-slate-500">{t('chat.subtitle')}</p>
                <div className="mt-5 grid w-full gap-2 sm:mt-7 sm:grid-cols-2 sm:gap-2.5">
                  {SUGGESTIONS.map(({ key, icon: Icon }) => (
                    <button
                      key={key}
                      onClick={() => send(t(`chat.${key}`))}
                      className="group flex items-start gap-3 rounded-2xl bg-white px-4 py-3 text-left sm:py-3.5 text-sm text-slate-700 shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.07] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] hover:ring-brand-300"
                    >
                      <span className="rounded-lg bg-brand-50 p-1.5 text-brand-600 transition-colors group-hover:bg-brand-100">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="pt-0.5">{t(`chat.${key}`)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user' ? (
                <UserBubble key={i} text={m.content} voice={m.voice} />
              ) : (
                <AssistantMessage
                  key={i}
                  id={msgId(m, i)}
                  m={m}
                  question={messages[i - 1]?.role === 'user' ? messages[i - 1].content : ''}
                  followUps={i === lastAssistant && !ask.isPending ? m.reply?.follow_ups : undefined}
                  onAsk={(q) => send(q)}
                />
              ),
            )}

            {ask.isPending && <Thinking />}
            {ask.error && <ErrorNote error={ask.error} onRetry={retry} />}
            <div ref={end} />
          </div>
        </div>

        <form onSubmit={submit} className="border-t border-slate-100 bg-white px-3 pb-2 pt-3 sm:px-4">
          {(dictation.status !== 'idle' || dictation.error) && (
            <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1 text-xs">
              {dictation.status === 'listening' && (
                <span className="inline-flex items-center gap-2 font-medium text-red-600">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                  {t('chat.listening', { language: languageName(voiceLang) })}
                  {dictation.level > 0 && (
                    <span className="flex h-3 items-end gap-0.5" aria-hidden>
                      {[0.5, 0.8, 1, 0.8, 0.5].map((k, j) => (
                        <span key={j} className="w-0.5 rounded-full bg-red-400" style={{ height: `${Math.max(15, dictation.level * k * 100)}%` }} />
                      ))}
                    </span>
                  )}
                </span>
              )}
              {dictation.status === 'transcribing' && (
                <span className="inline-flex items-center gap-1.5 text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" />
                  {t('chat.transcribing')}
                </span>
              )}
              {dictation.error && dictation.status === 'idle' && (
                <span role="alert" className="inline-flex items-center gap-1.5 text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t(`chat.${dictation.error}`)}
                  <button type="button" onClick={dictation.clearError} className="rounded p-0.5 hover:bg-amber-50" aria-label={t('common.close')}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
          )}
          <div
            className={cn(
              'mx-auto flex max-w-3xl items-end gap-1.5 rounded-2xl bg-white p-1.5 shadow-[var(--shadow-soft)] ring-1 ring-inset ring-slate-900/[0.1] transition focus-within:shadow-[0_0_0_4px_rgb(34_167_139/0.12)] focus-within:ring-2 focus-within:ring-brand-500',
              dictation.status === 'listening' && 'bg-white ring-2 ring-red-300',
            )}
          >
            <MicButton dictation={dictation} disabled={ask.isPending} />
            <textarea
              ref={box}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                if (!e.target.value) lastByVoice.current = false
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send(input)
                }
              }}
              rows={1}
              placeholder={dictation.status === 'listening' ? t('chat.speak_now') : t('chat.placeholder')}
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!input.trim() || ask.isPending}
              title={t('chat.send')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-brand-500 to-brand-700 text-white shadow-[var(--shadow-glow)] transition hover:brightness-110 disabled:bg-none disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
            >
              <ArrowUp className="h-4 w-4" />
              <span className="sr-only">{t('chat.send')}</span>
            </button>
          </div>
          <div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between gap-3 px-2 text-[11px] text-slate-400">
            <span className="hidden sm:inline">{t('chat.enter_hint')}</span>
            <label className="ml-auto inline-flex items-center gap-1">
              <Languages className="h-3 w-3" />
              {t('chat.voice_lang')}
              <select
                value={voiceLang}
                onChange={(e) => setVoiceLang(e.target.value)}
                className="rounded border-0 bg-transparent py-0 pr-5 pl-1 text-[11px] text-slate-600 focus:ring-1 focus:ring-brand-500"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </form>
      </Card>
    </div>
  )
}

function UserBubble({ text, voice }: { text: string; voice?: boolean }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-[0.925rem] text-white shadow-[var(--shadow-glow)] sm:max-w-[75%]">
        {voice && <Mic className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5 opacity-70" />}
        {text}
      </div>
    </div>
  )
}

function MicButton({ dictation, disabled }: { dictation: ReturnType<typeof useDictation>; disabled: boolean }) {
  const { t } = useTranslation()
  const active = dictation.status === 'listening'
  const busy = dictation.status === 'transcribing'
  const unavailable = !dictation.supported
  return (
    <button
      type="button"
      onClick={() => (active ? dictation.stop() : dictation.start())}
      disabled={disabled || busy}
      title={unavailable ? t(dictation.secure ? 'chat.mic_unsupported' : 'chat.mic_insecure') : active ? t('chat.mic_stop') : t('chat.mic_start')}
      aria-pressed={active}
      className={cn(
        'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
        active ? 'bg-red-500 text-white shadow-sm hover:bg-red-600' : 'text-slate-500 hover:bg-slate-200/70 hover:text-brand-700',
        unavailable && 'opacity-50',
        'disabled:opacity-40',
      )}
    >
      {active && <span className="absolute inset-0 animate-ping rounded-xl bg-red-400/40" />}
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? <Square className="relative h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
      <span className="sr-only">{active ? t('chat.mic_stop') : t('chat.mic_start')}</span>
    </button>
  )
}

function Avatar() {
  return (
    <div className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm sm:flex">
      <MessageCircleHeart className="h-4 w-4" />
    </div>
  )
}

function Thinking() {
  const { t } = useTranslation()
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="flex items-center gap-3 rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-slate-500 shadow-sm ring-1 ring-slate-200">
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500" style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
        {t('chat.thinking')}
      </div>
    </div>
  )
}

function AssistantMessage({
  id,
  m,
  question,
  followUps,
  onAsk,
}: {
  id: string
  m: Msg
  question: string
  followUps?: string[]
  onAsk: (q: string) => void
}) {
  const { t } = useTranslation()
  const lang = useLang()
  const r = m.reply
  const replyLang = r?.reply_language || lang
  // Show what was understood when the question was typed in English letters but answered in another language.
  const latin = (question.match(/[A-Za-z]/g)?.length ?? 0) > question.replace(/\s/g, '').length * 0.6
  const showUnderstood = !!r?.understood_question && replyLang !== 'en' && latin
  const [showSources, setShowSources] = useState(false)
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="min-w-0 flex-1 space-y-2.5">
        {r?.emergency_notice && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-sm font-medium text-red-800 ring-1 ring-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {r.emergency_notice}
          </div>
        )}

        <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-[var(--shadow-soft)] ring-1 ring-slate-900/[0.07]">
          {(showUnderstood || (r && replyLang !== lang) || (r && !r.answered_from_records)) && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {r && replyLang !== lang && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700 ring-1 ring-sky-200">
                  <Languages className="h-3 w-3" />
                  {t('chat.replied_in', { language: languageName(replyLang) })}
                </span>
              )}
              {r && !r.answered_from_records && (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  <Info className="h-3 w-3" />
                  {t('chat.not_in_records')}
                </span>
              )}
              {showUnderstood && (
                <span className="text-xs text-slate-400 italic">
                  {t('chat.understood')}: “{r?.understood_question}”
                </span>
              )}
            </div>
          )}
          <ChatMarkdown text={m.content} />
          {r?.suggest_doctor && (
            <p className="mt-3 flex items-center gap-1.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
              <Stethoscope className="h-3.5 w-3.5 text-brand-600" />
              {t('chat.doctor_hint')}
            </p>
          )}
        </div>

        {r && r.results?.length > 0 && <ResultsCard results={r.results} />}
        {r && r.medications?.length > 0 && <MedicinesCard meds={r.medications} />}

        <div className="flex flex-wrap items-center gap-1">
          <CopyButton text={markdownToText(m.content)} />
          <ListenButton id={id} text={markdownToText(m.content)} lang={replyLang} />
          {r && r.citations.length > 0 && (
            <button
              onClick={() => setShowSources((s) => !s)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <BookMarked className="h-3.5 w-3.5" />
              {t('chat.sources_count', { count: r.citations.length })}
              <ChevronDown className={cn('h-3 w-3 transition-transform', showSources && 'rotate-180')} />
            </button>
          )}
        </div>
        {r && showSources && (
          <div className="flex flex-wrap gap-1.5">
            {r.citations.map((c) => (
              <SourceLink key={c.id} id={c.id} label={c.label} date={c.date} documentId={c.document_id} />
            ))}
          </div>
        )}

        {followUps && followUps.length > 0 && (
          <div className="pt-1">
            <p className="mb-1.5 text-xs font-medium text-slate-400">{t('chat.follow_ups')}</p>
            <div className="flex flex-wrap gap-2">
              {followUps.map((q) => (
                <button
                  key={q}
                  onClick={() => onAsk(q)}
                  className="rounded-full bg-brand-50 px-3 py-1.5 text-left text-sm text-brand-800 ring-1 ring-brand-200 transition-colors hover:bg-brand-100"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const actionCls = 'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700'

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard API needs a secure context; opening the dev server by LAN IP over http is not one.
      const ta = Object.assign(document.createElement('textarea'), { value: text })
      document.body.append(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button onClick={copy} className={actionCls}>
      {done ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? t('chat.copied') : t('chat.copy')}
    </button>
  )
}

function ListenButton({ id, text, lang }: { id: string; text: string; lang: string }) {
  const { t } = useTranslation()
  const speaker = useSpeaker()
  if (typeof window === 'undefined' || !('speechSynthesis' in window || 'Audio' in window)) return null
  const mine = speaker.id === id
  return (
    <>
      <button
        onClick={() => (mine ? stopSpeaking() : void speak(id, text, lang))}
        className={cn(actionCls, mine && 'bg-brand-50 text-brand-700')}
      >
        {mine && speaker.loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : mine ? (
          <VolumeX className="h-3.5 w-3.5" />
        ) : (
          <Volume2 className="h-3.5 w-3.5" />
        )}
        {mine ? (speaker.loading ? t('chat.preparing_audio') : t('chat.stop')) : t('chat.listen')}
      </button>
      {speaker.error && !speaker.id && speaker.lastId === id && <span className="text-xs text-amber-700">{t('chat.voice_error')}</span>}
    </>
  )
}
