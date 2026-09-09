import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { Eye, EyeOff, Pencil, Plus, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { INVALID_SESSION_MESSAGE } from '@/lib/auth'
import { queryClient } from '@/lib/query-client'

interface AccountNote {
  chatgptPassword: string | null
  email: string
  googlePassword: string | null
  note: string | null
  updatedAt: string | null
}

interface NoteDraft {
  chatgptPassword: string
  email: string
  googlePassword: string
  note: string
}

interface AccountNotesPanelProps {
  onInvalidSession: (message?: string) => Promise<string>
  session: Session
  suggestedEmails: string[]
}

const MASK = '••••••••'

function emptyDraft(email = ''): NoteDraft {
  return { chatgptPassword: '', email, googlePassword: '', note: '' }
}

function draftFromNote(note: AccountNote): NoteDraft {
  return {
    chatgptPassword: note.chatgptPassword ?? '',
    email: note.email,
    googlePassword: note.googlePassword ?? '',
    note: note.note ?? '',
  }
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

/** Owner-only notes per account: passwords behind an eye toggle, plus free text. */
export function AccountNotesPanel({
  onInvalidSession,
  session,
  suggestedEmails,
}: AccountNotesPanelProps) {
  const accessToken = session.access_token
  const notesQuery = useQuery({
    queryFn: () => fetchNotes(accessToken),
    queryKey: ['account-notes', session.user.id],
  })
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<NoteDraft | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notes = notesQuery.data ?? []
  const knownEmails = new Set(notes.map((note) => note.email))
  const suggestions = suggestedEmails
    .map((email) => email.trim().toLowerCase())
    .filter((email, index, all) => email && !knownEmails.has(email) && all.indexOf(email) === index)

  function toggleReveal(key: string) {
    setRevealed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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

  async function save(draft: NoteDraft) {
    setBusy(true)
    setError(null)
    try {
      await callApi('/api/login/notes', draft)
      await queryClient.invalidateQueries({ queryKey: ['account-notes', session.user.id] })
      setEditing(null)
      setAdding(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the note.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(email: string) {
    setBusy(true)
    setError(null)
    try {
      await callApi('/api/login/notes/delete', { email })
      await queryClient.invalidateQueries({ queryKey: ['account-notes', session.user.id] })
      if (editing?.email === email) setEditing(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove the note.')
    } finally {
      setBusy(false)
    }
  }

  function secretCell(note: AccountNote, field: 'chatgptPassword' | 'googlePassword') {
    const value = note[field]
    if (!value) {
      return <span className="text-muted-foreground">·</span>
    }
    const key = `${note.email}:${field}`
    const shown = revealed.has(key)
    return (
      <span className="inline-flex max-w-full items-center gap-1">
        <span className={shown ? 'font-mono break-all' : 'tracking-widest'}>
          {shown ? value : MASK}
        </span>
        <Button
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="size-6 shrink-0"
          onClick={() => toggleReveal(key)}
          size="icon"
          variant="ghost"
        >
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
      </span>
    )
  }

  function form(draft: NoteDraft, onCancel: () => void) {
    const update = (patch: Partial<NoteDraft>) => setEditing((current) => ({ ...(current ?? draft), ...patch }))
    const current = editing ?? draft
    return (
      <form
        className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault()
          void save(current)
        }}
      >
        <Input
          aria-label="Email"
          autoComplete="off"
          list="account-note-emails"
          onChange={(event) => update({ email: event.target.value })}
          placeholder="email"
          readOnly={!adding}
          required
          value={current.email}
        />
        <Input
          aria-label="ChatGPT password"
          autoComplete="off"
          onChange={(event) => update({ chatgptPassword: event.target.value })}
          placeholder="ChatGPT password"
          type="text"
          value={current.chatgptPassword}
        />
        <Input
          aria-label="Google password"
          autoComplete="off"
          onChange={(event) => update({ googlePassword: event.target.value })}
          placeholder="Google password"
          type="text"
          value={current.googlePassword}
        />
        <Input
          aria-label="Note"
          autoComplete="off"
          onChange={(event) => update({ note: event.target.value })}
          placeholder="note (resets, who holds it)"
          value={current.note}
        />
        <span className="flex items-center gap-1">
          <Button disabled={busy} size="sm" type="submit">
            Save
          </Button>
          <Button aria-label="Cancel" onClick={onCancel} size="icon" type="button" variant="ghost">
            <X className="size-4" />
          </Button>
        </span>
      </form>
    )
  }

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Account notes</CardTitle>
          <CardDescription>
            Passwords and reset notes for your accounts. Only you can read these; they are
            encrypted at rest and never shown to people you invite.
          </CardDescription>
        </div>
        <Button
          disabled={busy || adding}
          onClick={() => {
            setEditing(emptyDraft(suggestions[0] ?? ''))
            setAdding(true)
          }}
          size="sm"
          variant="outline"
        >
          <Plus className="size-4" /> Add
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <datalist id="account-note-emails">
          {suggestions.map((email) => (
            <option key={email} value={email} />
          ))}
        </datalist>
        {notesQuery.error ? (
          <p className="text-destructive text-sm">{notesQuery.error.message}</p>
        ) : null}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        {adding && editing ? form(editing, () => { setAdding(false); setEditing(null) }) : null}
        {notes.length === 0 && !adding ? (
          <p className="text-muted-foreground text-sm">No notes yet. Add one per account.</p>
        ) : null}
        {notes.length > 0 ? (
          <div className="grid gap-1 text-sm">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-2 px-2 text-muted-foreground text-xs sm:grid">
              <span>Account</span>
              <span>ChatGPT</span>
              <span>Google</span>
              <span>Note</span>
              <span />
            </div>
            {notes.map((note) =>
              editing && !adding && editing.email === note.email ? (
                <div key={note.email}>{form(editing, () => setEditing(null))}</div>
              ) : (
                <div
                  className="grid items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
                  key={note.email}
                >
                  <span className="truncate font-mono text-xs" title={note.email}>
                    {note.email}
                  </span>
                  <span className="min-w-0 text-xs">{secretCell(note, 'chatgptPassword')}</span>
                  <span className="min-w-0 text-xs">{secretCell(note, 'googlePassword')}</span>
                  <span className="min-w-0 truncate text-xs" title={note.note ?? ''}>
                    {note.note ?? <span className="text-muted-foreground">·</span>}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Button
                      aria-label={`Edit ${note.email}`}
                      className="size-6"
                      disabled={busy}
                      onClick={() => {
                        setAdding(false)
                        setEditing(draftFromNote(note))
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={`Remove ${note.email}`}
                      className="size-6"
                      disabled={busy}
                      onClick={() => void remove(note.email)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </div>
              ),
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
