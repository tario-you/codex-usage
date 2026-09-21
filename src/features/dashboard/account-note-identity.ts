import { isClaudeAccountKey } from '../../shared/codex'

export type NoteProvider = 'codex' | 'claude'

export function normalizeNoteEmail(email: string | null | undefined) {
  return (email ?? '').trim().toLowerCase()
}

export function noteKey(email: string | null | undefined, provider: NoteProvider) {
  return `${provider}:${normalizeNoteEmail(email)}`
}

export function accountNoteProvider(account: { account_key: string }): NoteProvider {
  return isClaudeAccountKey(account.account_key) ? 'claude' : 'codex'
}

export function accountNoteKey(account: { account_key: string; email: string | null }) {
  return noteKey(account.email, accountNoteProvider(account))
}
