// Two strings need checking, so this stays a plain check instead of pulling zod (about 55 KB) into the first script.
function readClientEnv() {
  const VITE_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  const VITE_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  const issues: string[] = []

  if (typeof VITE_SUPABASE_ANON_KEY !== 'string' || VITE_SUPABASE_ANON_KEY.length === 0) {
    issues.push('VITE_SUPABASE_ANON_KEY: Missing VITE_SUPABASE_ANON_KEY')
  }
  if (typeof VITE_SUPABASE_URL !== 'string' || !isUrl(VITE_SUPABASE_URL)) {
    issues.push('VITE_SUPABASE_URL: Missing or invalid VITE_SUPABASE_URL')
  }

  return issues.length > 0
    ? { data: null, error: issues.join('; ') }
    : {
        data: { VITE_SUPABASE_ANON_KEY: VITE_SUPABASE_ANON_KEY as string, VITE_SUPABASE_URL: VITE_SUPABASE_URL as string },
        error: null,
      }
}

function isUrl(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

const parsedClientEnv = readClientEnv()

export const clientEnv = parsedClientEnv.data
export const clientEnvError = parsedClientEnv.error
