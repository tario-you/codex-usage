import { createClient } from '@supabase/supabase-js'

import type { Database } from '../../src/lib/database.types.js'
import { serverEnv } from './env.js'

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
