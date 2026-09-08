import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { Ban, Check, Copy, KeyRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { INVALID_SESSION_MESSAGE } from '@/lib/auth'
import type { DashboardAccountRow } from '@/lib/dashboard'
import { queryClient } from '@/lib/query-client'
import { buildPublishLoginCommand, buildUseLoginWatchCommand } from '@/shared/cli'
import { formatRelativeTimestamp, formatTimestamp } from '@/shared/codex'

interface SharedLoginPublication {
  accountId: string
  deviceLabel: string | null
  email: string
  planType: string | null
  publishedAt: string
  tokenExpiresAt: string | null
  tokenIssuedAt: string
  updatedAt: string
}

interface SharedLoginGrant {
  accountId: string
  claimTokenPreview: string
  claimedAt: string | null
  claimedLabel: string | null
  claimedMachineName: string | null
  createdAt: string
  expiresAt: string
  id: string
  label: string | null
  lastPushedAt: string | null
  lastSyncedAt: string | null
  revokedAt: string | null
  status: 'active' | 'expired' | 'pending' | 'revoked'
  syncCount: number
}

interface SharedLoginShares {
  grants: SharedLoginGrant[]
  publications: SharedLoginPublication[]
}

interface LoginCommandState {
  accountId: string
  command: string
  expiresAt: string
}

const COPY_FEEDBACK_DURATION_MS = 2000

export function SharedLoginPanel({
  accounts,
  onInvalidSession,
  session,
}: {
  accounts: DashboardAccountRow[]
  onInvalidSession: (message?: string) => Promise<string>
  session: Session | null
}) {
  const accessToken = session?.access_token ?? null
  const userId = session?.user.id ?? 'guest'
  const [loginCommand, setLoginCommand] = useState<LoginCommandState | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  const sharesQuery = useQuery({
    enabled: Boolean(accessToken),
    queryFn: () => fetchShares(accessToken ?? ''),
    queryKey: ['login-shares', userId],
    refetchInterval: 30_000,
  })

  useEffect(() => {
    if (!copiedKey) {
      return
    }

    const timeoutId = window.setTimeout(() => setCopiedKey(null), COPY_FEEDBACK_DURATION_MS)
    return () => window.clearTimeout(timeoutId)
  }, [copiedKey])

  const shares = sharesQuery.data ?? { grants: [], publications: [] }
  const ownedAccountIds = new Set(
    accounts.filter((account) => account.access_scope === 'owned').map((account) => account.id),
  )
  const publications = shares.publications.filter((publication) =>
    ownedAccountIds.size === 0 ? true : ownedAccountIds.has(publication.accountId),
  )

  async function callApi<T>(path: string, body?: unknown): Promise<T> {
    if (!accessToken) {
      throw new Error('Sign in first.')
    }

    const response = await fetch(path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method: 'POST',
    })
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | { error?: string }
      | null

    if (!response.ok) {
      const message =
        payload && 'error' in payload && payload.error ? payload.error : 'Request failed.'
      if (response.status === 401) {
        throw new Error(await onInvalidSession(message || INVALID_SESSION_MESSAGE))
      }

      throw new Error(message)
    }

    return payload as T
  }

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyError(null)
      setCopiedKey(key)
    } catch {
      setCopiedKey(null)
      setCopyError('Copy failed. Select the command manually.')
    }
  }

  async function handleCreateCommand(publication: SharedLoginPublication) {
    setBusyKey(`grant:${publication.accountId}`)
    setError(null)

    try {
      const payload = await callApi<{ command: string; expiresAt: string }>(
        '/api/login/grants/start',
        { accountId: publication.accountId },
      )
      setLoginCommand({
        accountId: publication.accountId,
        command: payload.command,
        expiresAt: payload.expiresAt,
      })
      await copyText(`command:${publication.accountId}`, payload.command)
      await sharesQuery.refetch()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create the login command.')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRevoke(grant: SharedLoginGrant) {
    setBusyKey(`revoke:${grant.id}`)
    setError(null)

    try {
      await callApi('/api/login/grants/revoke', { grantId: grant.id })
      if (loginCommand && grant.status === 'pending') {
        setLoginCommand(null)
      }
      await sharesQuery.refetch()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to revoke this login.')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleStopSharing(publication: SharedLoginPublication) {
    if (!window.confirm(`Stop sharing the Codex login for ${publication.email}?`)) {
      return
    }

    setBusyKey(`unpublish:${publication.accountId}`)
    setError(null)

    try {
      await callApi('/api/login/unpublish', { accountId: publication.accountId })
      setLoginCommand(null)
      await sharesQuery.refetch()
      await queryClient.invalidateQueries({ queryKey: ['dashboard-accounts'] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to stop sharing.')
    } finally {
      setBusyKey(null)
    }
  }

  if (!session) {
    return null
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle>Share Codex login</CardTitle>
        <CardDescription>
          Let someone run their local Codex on one of your plans. Their machine
          receives your login and follows your token refreshes. Revoke it here at
          any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {sharesQuery.error ? (
          <Notice tone="error">{sharesQuery.error.message}</Notice>
        ) : null}

        {sharesQuery.isPending && !sharesQuery.data ? (
          <Notice tone="default">Loading shared logins...</Notice>
        ) : null}

        {sharesQuery.data && publications.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No login is published yet. On the machine paired with this
              dashboard, run this while Codex is logged into the plan you want
              to share. Add <span className="font-mono">--email you@example.com</span>{' '}
              to pick an account from the Codex switcher store instead.
            </p>
            <CommandBlock
              command={buildPublishLoginCommand()}
              copied={copiedKey === 'publish'}
              onCopy={() => void copyText('publish', buildPublishLoginCommand())}
            />
            {copyError ? (
              <p className="text-xs text-muted-foreground">{copyError}</p>
            ) : null}
          </div>
        ) : null}

        {publications.map((publication) => {
          const grants = shares.grants.filter(
            (grant) => grant.accountId === publication.accountId,
          )
          const visibleGrants = grants.filter(
            (grant) => grant.status === 'active' || grant.status === 'pending',
          )
          const isCreating = busyKey === `grant:${publication.accountId}`
          const isUnpublishing = busyKey === `unpublish:${publication.accountId}`

          return (
            <div
              key={publication.accountId}
              className="space-y-3 rounded-lg border border-border px-3 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <span className="truncate">{publication.email}</span>
                  </p>
                  <p className="text-muted-foreground">
                    {publication.planType ?? 'Unknown plan'} · login updated{' '}
                    {formatRelativeTimestamp(publication.updatedAt)}
                    {publication.deviceLabel ? ` from ${publication.deviceLabel}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {copiedKey === `command:${publication.accountId}` ? <CopiedPill /> : null}
                  <Button
                    disabled={Boolean(busyKey)}
                    onClick={() => void handleCreateCommand(publication)}
                    size="sm"
                    type="button"
                  >
                    {isCreating ? 'Creating command...' : 'Create login command'}
                  </Button>
                  <Button
                    disabled={Boolean(busyKey)}
                    onClick={() => void handleStopSharing(publication)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {isUnpublishing ? 'Stopping...' : 'Stop sharing'}
                  </Button>
                </div>
              </div>

              {loginCommand?.accountId === publication.accountId ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">
                      Send this to the person. They run it once.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Single use · expires {formatTimestamp(loginCommand.expiresAt)}
                    </p>
                  </div>
                  <CommandBlock
                    command={loginCommand.command}
                    copied={copiedKey === `command:${publication.accountId}`}
                    onCopy={() =>
                      void copyText(`command:${publication.accountId}`, loginCommand.command)
                    }
                  />
                  {copyError ? (
                    <p className="text-xs text-muted-foreground">{copyError}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Their previous Codex login is backed up. To keep following
                    your refreshes they leave{' '}
                    <span className="font-mono">{buildUseLoginWatchCommand()}</span>{' '}
                    running.
                  </p>
                </div>
              ) : null}

              {visibleGrants.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {visibleGrants.map((grant) => (
                    <li
                      key={grant.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {describeGrant(grant)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {describeGrantActivity(grant)}
                        </p>
                      </div>
                      <Button
                        aria-label="Revoke this login"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={Boolean(busyKey)}
                        onClick={() => void handleRevoke(grant)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <Ban className="mr-1 size-3.5" />
                        {busyKey === `revoke:${grant.id}` ? 'Revoking...' : 'Revoke'}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        })}

        {publications.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Revoking stops updates immediately. A revoked machine keeps working
            until the tokens rotate, which happens within about ten days.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

async function fetchShares(accessToken: string): Promise<SharedLoginShares> {
  const response = await fetch('/api/login/shares', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = (await response.json().catch(() => null)) as
    | SharedLoginShares
    | { error?: string }
    | null

  if (!response.ok) {
    throw new Error(
      payload && 'error' in payload && payload.error
        ? payload.error
        : 'Unable to load shared logins.',
    )
  }

  return payload as SharedLoginShares
}

function describeGrant(grant: SharedLoginGrant) {
  const who = grant.claimedLabel ?? grant.claimedMachineName ?? grant.label
  if (grant.status === 'pending') {
    return who ? `${who} · waiting to be used` : 'Login command waiting to be used'
  }

  return who ?? 'Recipient'
}

function describeGrantActivity(grant: SharedLoginGrant) {
  if (grant.status === 'pending') {
    return `Created ${formatRelativeTimestamp(grant.createdAt)} · expires ${formatTimestamp(grant.expiresAt)}`
  }

  const synced = grant.lastSyncedAt
    ? `last synced ${formatRelativeTimestamp(grant.lastSyncedAt)}`
    : 'never synced'
  return `Installed ${formatRelativeTimestamp(grant.claimedAt)} · ${synced}`
}

function CommandBlock({
  command,
  copied,
  onCopy,
}: {
  command: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 break-all text-foreground">
      <Button
        aria-label={copied ? 'Command copied' : 'Copy command'}
        className="absolute top-2 right-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={onCopy}
        size="icon-sm"
        title={copied ? 'Command copied' : 'Copy command'}
        type="button"
        variant="ghost"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {command}
    </div>
  )
}

function CopiedPill() {
  return (
    <span
      aria-live="polite"
      className="inline-flex h-6 items-center rounded-full border px-2.5 text-[0.72rem] font-medium"
      role="status"
      style={{
        backgroundColor: 'var(--success-surface)',
        borderColor: 'var(--success-border)',
        color: 'var(--success-foreground)',
      }}
    >
      <Check className="mr-1 size-3" />
      Copied
    </span>
  )
}

function Notice({
  children,
  tone,
}: {
  children: string
  tone: 'default' | 'error'
}) {
  const toneClassName =
    tone === 'error'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-border bg-muted text-foreground'

  return <div className={`rounded-lg border px-3 py-2 text-sm ${toneClassName}`}>{children}</div>
}
