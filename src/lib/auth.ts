import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { queryClient } from './query-client'
import { supabase } from './supabase'

export function useAuthSession() {
  const [isLoading, setIsLoading] = useState(Boolean(supabase))
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) {
      return
    }

    let cancelled = false

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session ?? null)
        setIsLoading(false)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      void queryClient.invalidateQueries({ queryKey: ['dashboard-accounts'] })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  return {
    isLoading,
    session,
  }
}
