import { z } from 'zod'

const serverEnvSchema = z.object({
  SUPABASE_JWKS: z.string().min(2).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_URL: z.string().url(),
})

export const serverEnv = serverEnvSchema.parse({
  SUPABASE_JWKS: process.env.SUPABASE_JWKS || undefined,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
})
