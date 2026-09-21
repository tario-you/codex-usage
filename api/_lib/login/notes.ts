import {
  accountNoteAssociatedData,
  accountNoteInputSchema,
  isEmptyAccountNote,
  normalizeAccountNoteFields,
  parseAccountNote,
  serializeAccountNote,
} from '../account-notes.js'
import { requireUser } from '../auth.js'
import { jsonResponse } from '../http.js'
import {
  decryptSharedLogin,
  encryptSharedLogin,
  loadLoginEncryptionKey,
} from '../login-crypto.js'
import { SharedLoginError } from '../login-reconcile.js'
import { sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'

const TABLE = 'codex_account_notes'

async function readBody(request: Request) {
  const body: unknown = await request.json().catch(() => null)
  const parsed = accountNoteInputSchema.safeParse(body)
  if (!parsed.success) {
    throw new SharedLoginError(
      'Choose Codex or Claude and enter a valid email address; passwords stay under 512 characters and notes under 2000.',
      400,
    )
  }
  return parsed.data
}

/** The caller's own notes, decrypted for the caller only. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    const key = loadLoginEncryptionKey()
    const { data, error } = await serviceRoleSupabase
      .from(TABLE)
      .select('email, provider, ciphertext, key_version, aad_version, updated_at')
      .eq('owner_user_id', user.id)
      .order('email')
    if (error) {
      throw new SharedLoginError('Unable to load account notes.', 500)
    }

    const notes = (data ?? []).map((row) => ({
      email: row.email,
      provider: row.provider,
      updatedAt: row.updated_at,
      ...parseAccountNote(
        decryptSharedLogin(
          row.ciphertext,
          accountNoteAssociatedData(user.id, row.email, row.provider, row.aad_version),
          row.key_version,
          key,
        ),
      ),
    }))

    return jsonResponse({ notes })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load account notes.')
  }
}

/** Upsert one note. Clearing every field removes the row. */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const input = await readBody(request)
    const fields = normalizeAccountNoteFields(input)

    if (isEmptyAccountNote(fields)) {
      await removeNote(user.id, input.email, input.provider)
      return jsonResponse({ deleted: true, email: input.email, provider: input.provider })
    }

    const key = loadLoginEncryptionKey()
    const encrypted = encryptSharedLogin(
      serializeAccountNote(fields),
      accountNoteAssociatedData(user.id, input.email, input.provider),
      key,
    )
    const { data, error } = await serviceRoleSupabase
      .from(TABLE)
      .upsert(
        {
          owner_user_id: user.id,
          email: input.email,
          provider: input.provider,
          aad_version: 2,
          ciphertext: encrypted.ciphertext,
          key_version: encrypted.keyVersion,
        },
        { onConflict: 'owner_user_id,provider,email' },
      )
      .select('email, provider, updated_at')
      .single()
    if (error || !data) {
      throw new SharedLoginError('Unable to save the account note.', 500)
    }

    return jsonResponse({
      note: { email: data.email, provider: data.provider, updatedAt: data.updated_at, ...fields },
    })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to save the account note.')
  }
}

/** Remove one note. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request)
    const input = await readBody(request)
    await removeNote(user.id, input.email, input.provider)
    return jsonResponse({ deleted: true, email: input.email, provider: input.provider })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to remove the account note.')
  }
}

async function removeNote(ownerUserId: string, email: string, provider: 'codex' | 'claude') {
  const { error } = await serviceRoleSupabase
    .from(TABLE)
    .delete()
    .eq('owner_user_id', ownerUserId)
    .eq('email', email)
    .eq('provider', provider)
  if (error) {
    throw new SharedLoginError('Unable to remove the account note.', 500)
  }
}
