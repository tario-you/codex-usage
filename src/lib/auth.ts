import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { queryClient } from './query-client'
import { supabase } from './supabase'

type EmailOtpType =
  | 'email'
  | 'email_change'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'signup'

const emailOtpTypes = new Set<EmailOtpType>([
  'email',
  'email_change',
  'invite',
  'magiclink',
  'recovery',
  'signup',
])

export function useAuthSession() {
  const [isLoading, setIsLoading] = useState(Boolean(supabase))
  const [redirectError, setRedirectError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) {
      return
    }

    let cancelled = false

    void hydrateAuthState().then(({ error, session: nextSession }) => {
      if (cancelled) {
        return
      }

      setRedirectError(error)
      setSession(nextSession)
      setIsLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      void queryClient.invalidateQueries({ queryKey: ['dashboard-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard-inviters'] })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  return {
    isLoading,
    redirectError,
    session,
  }
}

async function hydrateAuthState() {
  if (!supabase) {
    return {
      error: null,
      session: null,
    }
  }

  const error = await resolveSessionFromRedirect()
  const { data } = await supabase.auth.getSession()

  return {
    error,
    session: data.session ?? null,
  }
}

async function resolveSessionFromRedirect() {
  if (typeof window === 'undefined' || !supabase) {
    return null
  }

  const url = new URL(window.location.href)
  const tokenHash = url.searchParams.get('token_hash')
  const verificationType = url.searchParams.get('type')
  const code = url.searchParams.get('code')

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    removeRedirectParams(url, ['code'])
    return error?.message ?? null
  }

  if (!tokenHash || !verificationType || !isEmailOtpType(verificationType)) {
    return null
  }

  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: verificationType,
  })

  removeRedirectParams(url, ['token_hash', 'type'])
  return error?.message ?? null
}

function isEmailOtpType(value: string): value is EmailOtpType {
  return emailOtpTypes.has(value as EmailOtpType)
}

function removeRedirectParams(url: URL, names: string[]) {
  let didChange = false

  for (const name of names) {
    if (!url.searchParams.has(name)) {
      continue
    }

    url.searchParams.delete(name)
    didChange = true
  }

  if (didChange) {
    window.history.replaceState(window.history.state, '', url.toString())
  }
}
