import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './i18n'
import './index.css'
import { AuthProvider } from './lib/auth'
import { ApiError } from './lib/api'
import { registerWorker } from './lib/push'

void registerWorker()

// A profile removed elsewhere (another device, or a demo reset) leaves this tab with a stale list: reload it, and the
// app moves to a profile that exists.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 404 && error.message === 'Patient not found')
    void queryClient.invalidateQueries({ queryKey: ['patients'] })
}
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={null}>
            <App />
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
