import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Layout } from './components/Layout'
import { ErrorNote, Spinner } from './components/ui'
import { useAuth } from './lib/auth'
import { PatientProvider, usePatient } from './lib/patient'
import AuthPage from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Onboarding from './pages/Onboarding'

const UploadPage = lazy(() => import('./pages/Upload'))
const Review = lazy(() => import('./pages/Review'))
const DocumentView = lazy(() => import('./pages/DocumentView'))
const Timeline = lazy(() => import('./pages/Timeline'))
const Trends = lazy(() => import('./pages/Trends'))
const Medications = lazy(() => import('./pages/Medications'))
const Chat = lazy(() => import('./pages/Chat'))
const Abha = lazy(() => import('./pages/Abha'))
const Profiles = lazy(() => import('./pages/Profiles'))
const Account = lazy(() => import('./pages/Account'))
const Reminders = lazy(() => import('./pages/Reminders'))
const Insights = lazy(() => import('./pages/Insights'))
const Copilot = lazy(() => import('./pages/Copilot'))
const VisitSheet = lazy(() => import('./pages/VisitSheet'))

export default function App() {
  const { t } = useTranslation()
  const { account, loading, error } = useAuth()

  if (loading) return <Spinner className="h-full" label={t('common.loading')} />
  if (error)
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorNote error={error} onRetry={() => location.reload()} />
      </div>
    )
  if (!account) return <AuthPage />
  return (
    <PatientProvider key={account.id}>
      <SignedInApp />
    </PatientProvider>
  )
}

function SignedInApp() {
  const { t } = useTranslation()
  const { patient, loading, error } = usePatient()

  if (loading) return <Spinner className="h-full" label={t('common.loading')} />
  if (error && !patient)
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorNote error={error} onRetry={() => location.reload()} />
      </div>
    )
  if (!patient) return <Onboarding />

  return (
    <Routes>
        <Route path="/profiles/new" element={<Onboarding addMember />} />
        <Route
          path="/visit-sheet"
          element={
            <Suspense fallback={<Spinner className="h-full" />}>
              <VisitSheet />
            </Suspense>
          }
        />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="documents/:id" element={<DocumentView />} />
          <Route path="documents/:id/review" element={<Review />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="trends" element={<Trends />} />
          <Route path="medications" element={<Medications />} />
          <Route path="reminders" element={<Reminders />} />
          <Route path="insights" element={<Insights />} />
          <Route path="copilot" element={<Copilot />} />
          <Route path="chat" element={<Chat />} />
          <Route path="abha" element={<Abha />} />
          <Route path="profiles" element={<Profiles />} />
          <Route path="account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
    </Routes>
  )
}
