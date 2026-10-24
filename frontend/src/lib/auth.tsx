import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, UNAUTHORIZED_EVENT } from './api'
import type { Account } from './types'

interface AuthCtx {
  account: Account | null
  loading: boolean
  error: unknown
  signedIn: (account: Account) => void
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

async function fetchMe(): Promise<Account | null> {
  try {
    return await api.me()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: Infinity, retry: false })

  // On any account change (sign in, sign out, expired session) drop everything cached for the previous user
  // (records, summaries, chat) and start fresh on the home page with the account holder's own profile.
  const reset = useCallback(
    (account: Account | null) => {
      // Keep the ['me'] query itself: clearing it would detach the observer above from the new value.
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' })
      sessionStorage.clear()
      Object.keys(localStorage)
        .filter((k) => k.startsWith('hc.patient.'))
        .forEach((k) => localStorage.removeItem(k))
      navigate('/', { replace: true })
      qc.setQueryData(['me'], account)
    },
    [qc, navigate],
  )

  useEffect(() => {
    const expired = () => reset(null)
    window.addEventListener(UNAUTHORIZED_EVENT, expired)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, expired)
  }, [reset])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined)
    reset(null)
  }, [reset])

  return (
    <Ctx.Provider value={{ account: q.data ?? null, loading: q.isLoading, error: q.error, signedIn: reset, signOut }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
