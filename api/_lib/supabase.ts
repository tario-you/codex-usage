import { createClient } from '@supabase/supabase-js'

import type { Database } from '../../src/lib/database.types'
import { serverEnv } from './env'

export const serviceRoleSupabase = createClient<Database>(
  serverEnv.SUPABASE_URL,
  serverEnv.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
)
