/** Voice for the chat: reading replies aloud and dictating questions. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

const LOCALES: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN',
  gu: 'gu-IN', pa: 'pa-IN', or: 'or-IN', ur: 'ur-IN', as: 'as-IN', ne: 'ne-NP', si: 'si-LK', ar: 'ar-SA', es: 'es-ES',
  fr: 'fr-FR', de: 'de-DE',
}
export const speechLocale = (lang: string) => LOCALES[lang] ?? lang

/** "తెలుగు" for "te": the language's own name, for badges. */
export function languageName(code: string) {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

// ---------- reading aloud ----------

interface SpeakState {
  id: string | null
  lastId: string | null
  loading: boolean
  error: string | null
}
let state: SpeakState = { id: null, lastId: null, loading: false, error: null }
const listeners = new Set<() => void>()
const set = (s: Partial<SpeakState>) => {
  state = { ...state, ...s }
  listeners.forEach((l) => l())
}
let audio: HTMLAudioElement | null = null
let run = 0

export function useSpeaker() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export function stopSpeaking() {
  run++
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  audio?.pause()
  audio = null
  set({ id: null, loading: false })
}

async function voices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return []
  const now = window.speechSynthesis.getVoices()
  if (now.length) return now
  // Chrome fills the list asynchronously.
  return new Promise((resolve) => {
    const done = () => resolve(window.speechSynthesis.getVoices())
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 700)
  })
}

function pickVoice(list: SpeechSynthesisVoice[], lang: string) {
  const want = speechLocale(lang).toLowerCase()
  const norm = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase()
  return list.find((v) => norm(v) === want) ?? list.find((v) => norm(v).split('-')[0] === lang) ?? null
}

/**
 * Sentence-sized pieces. Browsers cut long utterances short (Chrome stops after ~15 s), and for server audio a short
 * first piece means the answer starts playing sooner while the rest is generated.
 */
function chunks(text: string, first = 220, rest = 220) {
  const parts = text.match(/[^.!?।۔\n]+[.!?।۔]*\s*/g) ?? [text]
  const out: string[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && last.length + p.length < (out.length === 1 ? first : rest)) out[out.length - 1] = last + p
    else out.push(p)
  }
  return out.map((c) => c.trim()).filter(Boolean)
}

async function serverAudio(text: string, lang: string): Promise<Blob> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  })
  if (!res.ok) throw new Error(String(res.status))
  return res.blob()
}

function play(blob: Blob, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const el = new Audio(url)
    audio = el
    const done = (ok: boolean) => {
      URL.revokeObjectURL(url)
      if (ok) resolve()
      else reject(new Error('playback'))
    }
    el.onended = () => done(true)
    el.onerror = () => done(false)
    if (!isCurrent()) return done(true)
    el.play().catch(() => done(false))
  })
}

/**
 * Reads `text` in `lang`, using a voice installed on the device when there is one and the server's voice otherwise
 * (most desktops have no Telugu, Tamil or Kannada voice). Calls `onEnd` when finished, not when stopped.
 */
export async function speak(id: string, text: string, lang: string, onEnd?: () => void) {
  stopSpeaking()
  const mine = ++run
  set({ id, lastId: id, loading: true, error: null })
  const voice = pickVoice(await voices(), lang)
  if (mine !== run) return

  const finish = () => {
    if (mine !== run) return
    set({ id: null, loading: false })
    onEnd?.()
  }

  if (voice) {
    const parts = chunks(text)
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p)
      u.voice = voice
      u.lang = voice.lang
      u.rate = 0.95
      if (i === 0) u.onstart = () => mine === run && set({ loading: false })
      if (i === parts.length - 1) u.onend = finish
      u.onerror = (e) => {
        if (e.error !== 'interrupted' && e.error !== 'canceled') finish()
      }
      window.speechSynthesis.speak(u)
    })
    return
  }

  // Server voice: the first sentence is requested on its own so playback starts quickly; the next pieces are
  // generated while earlier ones play.
  const parts = chunks(text, 140, 400)
  const pending: (Promise<Blob> | undefined)[] = []
  const fetchPart = (i: number) => {
    if (i < parts.length && !pending[i]) pending[i] = serverAudio(parts[i], lang)
    pending[i]?.catch(() => undefined)
  }
  fetchPart(0)
  fetchPart(1)
  try {
    for (let i = 0; i < parts.length; i++) {
      fetchPart(i)
      const blob = await pending[i]!
      if (mine !== run) return
      fetchPart(i + 1)
      fetchPart(i + 2)
      if (i === 0) set({ loading: false })
      await play(blob, () => mine === run)
      if (mine !== run) return
    }
    finish()
  } catch {
    if (mine === run) set({ id: null, loading: false, error: 'voice_error' })
  }
}

// ---------- dictation ----------

interface RecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}
interface Recognition extends EventTarget {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition
const ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

const NativeRecognition: RecognitionCtor | undefined =
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition)

export type DictationStatus = 'idle' | 'listening' | 'transcribing'
export type DictationError = 'mic_denied' | 'mic_insecure' | 'mic_unsupported' | 'no_speech' | 'voice_error'

function canRecord() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && 'MediaRecorder' in window
}

interface Recording {
  spoke: () => boolean
  /** Stops and returns the audio, or null when nobody spoke. */
  finish: () => Promise<Blob | null>
  cancel: () => void
}

/**
 * Records the microphone with a level meter. `onTurnEnd` fires once: after a pause when the user has spoken, after
 * 8 s of nothing, or after 45 s. The speech threshold sits a little above the room's background noise and stays low
 * enough for quiet laptop microphones.
 */
async function record(onLevel: (level: number) => void, onTurnEnd: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const parts: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data)
  const ctx = new AudioContext()
  void ctx.resume().catch(() => undefined)
  const analyser = ctx.createAnalyser()
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  let spoke = false
  let voiced = 0
  let floor = 0.004
  let ended = false
  let quietSince = performance.now()
  const started = performance.now()
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    const rms = Math.sqrt(sum / buf.length)
    onLevel(Math.min(1, rms * 8))
    const now = performance.now()
    const threshold = Math.min(0.05, Math.max(0.008, floor * 2.5))
    if (rms > threshold) {
      voiced++
      quietSince = now
      if (voiced >= 2) spoke = true // two loud frames in a row, so a click or a cough doesn't count
    } else {
      voiced = 0
      floor = floor * 0.9 + rms * 0.1
    }
    if (!ended && ((spoke && now - quietSince > 1300) || now - started > 45_000 || (!spoke && now - started > 8000))) {
      ended = true
      onTurnEnd()
    }
  }, 80)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    onLevel(0)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
  const blob = () => (spoke && parts.length ? new Blob(parts, { type: rec.mimeType || 'audio/webm' }) : null)
  rec.start()
  return {
    spoke: () => spoke,
    finish: () =>
      new Promise((resolve) => {
        if (rec.state === 'inactive') {
          close()
          return resolve(blob())
        }
        rec.onstop = () => resolve(blob())
        rec.stop()
        close()
      }),
    cancel: () => {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      close()
    },
  }
}

async function transcribe(audio: Blob, lang: string): Promise<string> {
  const fd = new FormData()
  fd.append('audio', audio, 'question.webm')
  fd.append('lang', lang)
  const res = await fetch('/api/voice/transcribe', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(String(res.status))
  return ((await res.json()) as { text: string }).text.trim()
}

/**
 * Speech to text. Uses the browser's recogniser (Chrome, Edge, Safari) for instant text. On computers the question is
 * also recorded: when the recogniser's online service is blocked, slow or silent (common on office networks), the
 * recording is transcribed on our server instead, so a spoken question is never lost. Phones use the recogniser
 * alone (their microphone can't be shared) and switch to recording if its service fails. Firefox only records.
 */
export function useDictation({ lang, onInterim, onFinal }: { lang: string; onInterim: (t: string) => void; onFinal: (t: string) => void }) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<DictationError | null>(null)
  const [level, setLevel] = useState(0)
  const useServer = useRef(!NativeRecognition)
  const stopRef = useRef<() => void>(() => undefined)
  const cancelRef = useRef<() => void>(() => undefined)
  const cbs = useRef({ onInterim, onFinal })
  useEffect(() => {
    cbs.current = { onInterim, onFinal }
  })

  const secure = typeof window === 'undefined' || window.isSecureContext
  const supported = secure && (!!NativeRecognition || canRecord())

  const begin = useCallback(
    async function run(native: boolean): Promise<void> {
      const withRecording = canRecord() && (!native || !MOBILE)
      if (!native && !withRecording) return setError('mic_unsupported')
      let rec: Recognition | null = null
      let recording: Recording | null = null
      let done = false
      let nativeOver = !native // the recogniser ended or failed; only the recording is left
      let heard = ''
      let endTimer: ReturnType<typeof setTimeout> | undefined
      let silence: ReturnType<typeof setTimeout> | undefined
      let grace: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        done = true
        clearTimeout(endTimer)
        clearTimeout(silence)
        clearTimeout(grace)
        if (rec && !nativeOver) {
          nativeOver = true
          try {
            rec.abort()
          } catch {
            /* already stopped */
          }
        }
      }
      const finish = async () => {
        if (done) return
        cleanup()
        if (heard.trim()) {
          recording?.cancel()
          setStatus('idle')
          return cbs.current.onFinal(heard.trim())
        }
        const audio = recording ? await recording.finish() : null
        if (!audio) {
          setStatus('idle')
          return setError('no_speech')
        }
        setStatus('transcribing')
        try {
          const text = await transcribe(audio, lang)
          if (text) cbs.current.onFinal(text)
          else setError('no_speech')
        } catch {
          setError('voice_error')
        } finally {
          setStatus('idle')
        }
      }
      // The recording heard the end of the question. If the recogniser has text it finishes the turn itself; if it
      // has nothing yet it gets a moment to catch up before the recording is transcribed instead.
      const onTurnEnd = () => {
        if (done || heard) return
        clearTimeout(grace)
        grace = setTimeout(() => void finish(), nativeOver ? 0 : 1200)
      }

      if (withRecording) {
        try {
          recording = await record(setLevel, onTurnEnd)
        } catch {
          if (!native) return setError('mic_denied')
        }
      }
      cancelRef.current = () => {
        cleanup()
        recording?.cancel()
        setStatus('idle')
      }
      stopRef.current = () => {
        if (done) return
        if (rec && !nativeOver && heard) {
          rec.stop()
          endTimer = setTimeout(() => void finish(), 1500)
        } else void finish()
      }

      if (native && NativeRecognition) {
        rec = new NativeRecognition()
        rec.lang = speechLocale(lang)
        rec.interimResults = true
        // Continuous mode lets slow speakers pause mid-sentence; we end the turn ourselves. Android's recogniser
        // repeats earlier text in continuous mode, so it keeps the single-utterance mode there.
        rec.continuous = !ANDROID
        rec.maxAlternatives = 1
        if (!recording) silence = setTimeout(() => !heard && rec?.stop(), 8000)
        rec.onresult = (e) => {
          let fin = ''
          let interim = ''
          for (let i = 0; i < e.results.length; i++) {
            const r = e.results[i]
            if (r.isFinal) fin += r[0].transcript
            else interim += r[0].transcript
          }
          heard = (fin + interim).trim()
          cbs.current.onInterim(heard)
          // End the turn soon after a finished phrase, a little later while words are still arriving.
          clearTimeout(endTimer)
          clearTimeout(grace)
          endTimer = setTimeout(() => {
            rec?.stop()
            endTimer = setTimeout(() => void finish(), 1500) // in case the recogniser never reports its end
          }, interim ? 1600 : 900)
        }
        rec.onerror = (e) => {
          if (done) return
          if (e.error === 'aborted') return
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            if (recording) {
              nativeOver = true // the recogniser's service is refused, the microphone itself works
              return
            }
            cleanup()
            setStatus('idle')
            return setError('mic_denied')
          }
          nativeOver = true
          if (e.error === 'network' || e.error === 'language-not-supported') useServer.current = true
          if (recording) return // keep recording; it ends the turn and is transcribed on the server
          cleanup()
          setStatus('idle')
          if (e.error === 'network' || e.error === 'language-not-supported') return void run(false)
          setError(e.error === 'no-speech' ? 'no_speech' : 'voice_error')
        }
        rec.onend = () => {
          if (done) return
          nativeOver = true
          if (heard || !recording) void finish()
        }
        try {
          rec.start()
        } catch {
          nativeOver = true
          if (!recording) return setError('voice_error')
        }
      }
      setStatus('listening')
    },
    [lang],
  )

  const start = useCallback(() => {
    setError(null)
    if (!secure) return setError('mic_insecure')
    stopSpeaking()
    void begin(!!NativeRecognition && !useServer.current)
  }, [begin, secure])

  const stop = useCallback(() => stopRef.current(), [])
  useEffect(() => () => cancelRef.current(), [])

  return { status, error, level, supported, secure, start, stop, clearError: () => setError(null) }
}
