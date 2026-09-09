import { z } from 'zod'

/** Owner-only per-email notes. Everything here is pure so tests never touch env. */
export const ACCOUNT_NOTE_SECRET_MAX = 512
export const ACCOUNT_NOTE_TEXT_MAX = 2000

export const accountNoteInputSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(254)
    .refine((value) => value.includes('@'), 'Enter an email address.'),
  chatgptPassword: z.string().max(ACCOUNT_NOTE_SECRET_MAX).nullable().optional(),
  googlePassword: z.string().max(ACCOUNT_NOTE_SECRET_MAX).nullable().optional(),
  note: z.string().max(ACCOUNT_NOTE_TEXT_MAX).nullable().optional(),
})

export interface AccountNoteFields {
  chatgptPassword: string | null
  googlePassword: string | null
  note: string | null
}

/** Ciphertext is bound to the owner and the email, so a row cannot be moved. */
export function accountNoteAssociatedData(ownerUserId: string, email: string) {
  return `account-note:${ownerUserId}:${email}`
}

function cleanField(value: string | null | undefined) {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeAccountNoteFields(input: {
  chatgptPassword?: string | null
  googlePassword?: string | null
  note?: string | null
}): AccountNoteFields {
  return {
    chatgptPassword: cleanField(input.chatgptPassword),
    googlePassword: cleanField(input.googlePassword),
    note: cleanField(input.note),
  }
}

export function isEmptyAccountNote(fields: AccountNoteFields) {
  return !fields.chatgptPassword && !fields.googlePassword && !fields.note
}

export function serializeAccountNote(fields: AccountNoteFields) {
  return JSON.stringify({ v: 1, ...normalizeAccountNoteFields(fields) })
}

export function parseAccountNote(plaintext: string): AccountNoteFields {
  const parsed: unknown = JSON.parse(plaintext)
  const record =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' ? value : null)
  return normalizeAccountNoteFields({
    chatgptPassword: text(record.chatgptPassword),
    googlePassword: text(record.googlePassword),
    note: text(record.note),
  })
}
