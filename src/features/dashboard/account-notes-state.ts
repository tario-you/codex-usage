import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { INVALID_SESSION_MESSAGE } from '@/lib/auth'
import { queryClient } from '@/lib/query-client'

/**
 * Owner-only passwords and notes, shown inline in the Plans table. The values
 * are encrypted at rest, decrypted only for the owner's session, and never
 * sent to invited viewers (the API refuses anyone but the owner).
 */
export interface AccountNote {
  chatgptPassword: string | null
  email: string
  googlePassword: string | null
  note: string | null
  updatedAt: string | null
}

export interface NoteDraft {
  chatgptPassword: string
  email: string
  googlePassword: string
  note: string
}

export type SecretField = 'chatgptPassword' | 'googlePassword'

export const MASK = '••••••••'
export const NOTE_EMAILS_DATALIST_ID = 'account-note-emails'

export function emptyDraft(email = ''): NoteDraft {
  return { chatgptPassword: '', email, googlePassword: '', note: '' }
}

export function draftFromNote(note: AccountNote): NoteDraft {
  return {
    chatgptPassword: note.chatgptPassword ?? '',
    email: note.email,
    googlePassword: note.googlePassword ?? '',
    note: note.note ?? '',
  }
}

export function noteKey(email: string | null | undefined) {
  return (email ?? '').trim().toLowerCase()
}

async function fetchNotes(accessToken: string): Promise<AccountNote[]> {
  const response = await fetch('/api/login/notes', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; notes?: AccountNote[] }
    | null
  if (!response.ok) {
    throw new Error(payload?.error ?? 'Unable to load account notes.')
  }
  return payload?.notes ?? []
}

export interface AccountNotesController {
  adding: boolean
  busy: boolean
  byEmail: Map<string, AccountNote>
  cancel: () => void
  editing: NoteDraft | null
  error: string | null
  isEditing: (email: string | null | undefined) => boolean
  notes: AccountNote[]
  remove: (email: string) => Promise<void>
  revealed: Set<string>
  save: () => Promise<void>
  startAdd: (email?: string) => void
  startEdit: (email: string) => void
  toggleReveal: (key: string) => void
  update: (patch: Partial<NoteDraft>) => void
}

export function useAccountNotes({
  onInvalidSession,
  session,
}: {
  onInvalidSession: (message?: string) => Promise<string>
  session: Session | null
}): AccountNotesController | null {
  const accessToken = session?.access_token ?? null
  const userId = session?.user.id ?? null
  const notesQuery = useQuery({
    enabled: Boolean(accessToken),
    queryFn: () => fetchNotes(accessToken as string),
    queryKey: ['account-notes', userId],
  })
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<NoteDraft | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!accessToken) return null

  const notes = notesQuery.data ?? []
  const byEmail = new Map(notes.map((note) => [noteKey(note.email), note]))

  async function callApi(path: string, body: unknown) {
    const response = await fetch(path, {
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    if (!response.ok) {
      const message = payload?.error ?? 'Request failed.'
      if (response.status === 401) {
        throw new Error(await onInvalidSession(message || INVALID_SESSION_MESSAGE))
      }
      throw new Error(message)
    }
  }

  return {
    adding,
    busy,
    byEmail,
    cancel: () => {
      setEditing(null)
      setAdding(false)
    },
    editing,
    error: notesQuery.error?.message ?? error,
    isEditing: (email) => Boolean(editing) && !adding && noteKey(editing?.email) === noteKey(email),
    notes,
    async remove(email) {
      setBusy(true)
      setError(null)
      try {
        await callApi('/api/login/notes/delete', { email })
        await queryClient.invalidateQueries({ queryKey: ['account-notes', userId] })
        if (noteKey(editing?.email) === noteKey(email)) setEditing(null)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to remove the note.')
      } finally {
        setBusy(false)
      }
    },
    revealed,
    async save() {
      if (!editing) return
      setBusy(true)
      setError(null)
      try {
        await callApi('/api/login/notes', { ...editing, email: noteKey(editing.email) })
        await queryClient.invalidateQueries({ queryKey: ['account-notes', userId] })
        setEditing(null)
        setAdding(false)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to save the note.')
      } finally {
        setBusy(false)
      }
    },
    startAdd: (email = '') => {
      setAdding(true)
      setEditing(emptyDraft(noteKey(email)))
    },
    startEdit: (email) => {
      const existing = byEmail.get(noteKey(email))
      setAdding(false)
      setEditing(existing ? draftFromNote(existing) : emptyDraft(noteKey(email)))
    },
    toggleReveal: (key) => {
      setRevealed((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    },
    update: (patch) => setEditing((current) => ({ ...(current ?? emptyDraft()), ...patch })),
  }
}
