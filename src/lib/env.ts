import { z } from 'zod'

const clientEnvSchema = z.object({
  VITE_SUPABASE_ANON_KEY: z.string().min(1, 'Missing VITE_SUPABASE_ANON_KEY'),
  VITE_SUPABASE_URL: z
    .string()
    .url('Missing or invalid VITE_SUPABASE_URL'),
})

const parsedClientEnv = clientEnvSchema.safeParse({
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
})

export const clientEnv = parsedClientEnv.success ? parsedClientEnv.data : null
export const clientEnvError = parsedClientEnv.success
  ? null
  : parsedClientEnv.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
