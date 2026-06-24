import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Lock, LoaderCircle } from 'lucide-react'
import { useApplyTheme } from '../lib/theme'

interface AuthStatus {
  auth_required: boolean
  authenticated: boolean
}

type Phase = 'checking' | 'login' | 'ready'

// AuthGate sits above the router. Localhost connections are always trusted, so
// this is a no-op there: GET /api/auth/status returns auth_required=false and we
// render the app immediately. From a non-localhost device (e.g. a phone) the
// server reports auth_required=true until the correct key is presented, so we
// show a login screen. A successful login sets an HttpOnly cookie that every
// subsequent API and WebSocket request carries automatically.
export function AuthGate({ children }: { children: ReactNode }) {
  // Keep the login screen on-theme even though it renders before the router.
  useApplyTheme()

  const [phase, setPhase] = useState<Phase>('checking')
  const [key, setKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' })
      if (!res.ok) {
        // Endpoint should always be reachable; if not, fail open and let the app
        // surface the real error rather than trapping the user behind a login.
        setPhase('ready')
        return
      }
      const status: AuthStatus = await res.json()
      setPhase(status.auth_required && !status.authenticated ? 'login' : 'ready')
    } catch {
      setPhase('ready')
    }
  }, [])

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (res.ok) {
        setKey('')
        setPhase('ready')
        return
      }
      setError(res.status === 401 ? 'Incorrect key.' : `Login failed (${res.status}).`)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setSubmitting(false)
    }
  }

  if (phase === 'checking') {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <LoaderCircle className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  if (phase === 'login') {
    return (
      <div className="flex h-full items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
        <form
          onSubmit={onSubmit}
          className="max-w-sm w-full rounded-2xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-8"
        >
          <div className="mb-6 inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-700">
            <Lock className="w-6 h-6 text-blue-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-1 tracking-tight">
            Hydra
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
            This Hydra is being accessed from outside its machine. Enter the auth key
            to continue.
          </p>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Auth key"
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={submitting || key.length === 0}
            className="mt-5 w-full px-5 py-2.5 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting && <LoaderCircle className="w-4 h-4 animate-spin" />}
            Unlock
          </button>
        </form>
      </div>
    )
  }

  return <>{children}</>
}
