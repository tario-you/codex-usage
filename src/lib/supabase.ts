import { createClient } from '@supabase/supabase-js'

import type { Database } from './database.types'
import { clientEnv } from './env'

export const supabase = clientEnv
  ? createClient<Database>(
      clientEnv.VITE_SUPABASE_URL,
      clientEnv.VITE_SUPABASE_ANON_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )
  : null
