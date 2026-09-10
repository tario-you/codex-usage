import { Eye, EyeOff, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import {
  MASK,
  NOTE_EMAILS_DATALIST_ID,
  emptyDraft,
  noteKey,
  type AccountNote,
  type AccountNotesController,
  type SecretField,
} from './account-notes-state'

/** A password behind an eye toggle; a dot when there is none. */
export function NoteSecret({
  controller,
  field,
  note,
}: {
  controller: AccountNotesController
  field: SecretField
  note: AccountNote | undefined
}) {
  const value = note?.[field]
  if (!value) return <span className="text-muted-foreground">·</span>
  const key = `${noteKey(note?.email)}:${field}`
  const shown = controller.revealed.has(key)
  return (
    <span className="inline-flex max-w-full items-center gap-1 text-xs">
      <span className={shown ? 'font-mono break-all' : 'tracking-widest'}>{shown ? value : MASK}</span>
      <Button
        aria-label={shown ? 'Hide password' : 'Show password'}
        className="size-6 shrink-0"
        onClick={() => controller.toggleReveal(key)}
        size="icon"
        type="button"
        variant="ghost"
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
    </span>
  )
}

/** The inline editor: one row of inputs, email locked unless adding. */
export function NoteEditor({
  controller,
  emailSuggestions = [],
}: {
  controller: AccountNotesController
  emailSuggestions?: string[]
}) {
  const current = controller.editing ?? emptyDraft()
  return (
    <form
      className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault()
        void controller.save()
      }}
    >
      <datalist id={NOTE_EMAILS_DATALIST_ID}>
        {emailSuggestions.map((email) => (
          <option key={email} value={email} />
        ))}
      </datalist>
      <Input
        aria-label="Email"
        autoComplete="off"
        list={NOTE_EMAILS_DATALIST_ID}
        onChange={(event) => controller.update({ email: event.target.value })}
        placeholder="email"
        readOnly={!controller.adding}
        required
        value={current.email}
      />
      <Input
        aria-label="ChatGPT password"
        autoComplete="off"
        onChange={(event) => controller.update({ chatgptPassword: event.target.value })}
        placeholder="ChatGPT password"
        type="text"
        value={current.chatgptPassword}
      />
      <Input
        aria-label="Google password"
        autoComplete="off"
        onChange={(event) => controller.update({ googlePassword: event.target.value })}
        placeholder="Google password"
        type="text"
        value={current.googlePassword}
      />
      <Input
        aria-label="Note"
        autoComplete="off"
        onChange={(event) => controller.update({ note: event.target.value })}
        placeholder="note (resets, who holds it)"
        value={current.note}
      />
      <span className="flex items-center gap-1">
        <Button disabled={controller.busy} size="sm" type="submit">
          Save
        </Button>
        <Button aria-label="Cancel" onClick={controller.cancel} size="icon" type="button" variant="ghost">
          <X className="size-4" />
        </Button>
      </span>
    </form>
  )
}
