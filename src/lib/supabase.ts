import { createDashboardClient } from './dashboard-client'
import { clientEnv } from './env'

export const supabase = clientEnv
  ? createDashboardClient(clientEnv.VITE_SUPABASE_URL, clientEnv.VITE_SUPABASE_ANON_KEY)
  : null
