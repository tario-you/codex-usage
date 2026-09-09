import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { Ban, Check, ChevronDown, ChevronRight, Copy, KeyRound, Shuffle } from 'lucide-react'

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
import {
  buildPublishAllLoginsCommand,
  buildPublishLoginCommand,
  buildUseLoginWatchCommand,
} from '@/shared/cli'
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
  accountId: string | null
  claimTokenPreview: string
  claimedAt: string | null
  claimedLabel: string | null
  claimedMachineName: string | null
  createdAt: string
  currentAccountId: string | null
  currentEmail: string | null
  expiresAt: string
  id: string
  label: string | null
  lastPushedAt: string | null
  lastSyncedAt: string | null
  revokedAt: string | null
  scope: 'account' | 'pool'
  status: 'active' | 'expired' | 'pending' | 'revoked'
  switchCount: number
  switchedAt: string | null
  syncCount: number
}

interface SharedLoginShares {
  grants: SharedLoginGrant[]
  publications: SharedLoginPublication[]
}

interface LoginCommandState {
  command: string
  expiresAt: string
  key: string
  title: string
}

const COPY_FEEDBACK_DURATION_MS = 2000
const POOL_KEY = 'pool'

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
  const [showPlans, setShowPlans] = useState(false)

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
  const liveGrants = shares.grants.filter(
    (grant) => grant.status === 'active' || grant.status === 'pending',
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

  async function handleCreateCommand(target: SharedLoginPublication | 'pool') {
    const key = target === 'pool' ? POOL_KEY : target.accountId
    setBusyKey(`grant:${key}`)
    setError(null)

    try {
      const payload = await callApi<{ command: string; expiresAt: string }>(
        '/api/login/grants/start',
        target === 'pool'
          ? { scope: 'pool' }
          : { accountId: target.accountId, scope: 'account' },
      )
      setLoginCommand({
        command: payload.command,
        expiresAt: payload.expiresAt,
        key,
        title:
          target === 'pool'
            ? 'Auto-switching login across every plan below'
            : `Login pinned to ${target.email}`,
      })
      await copyText(`command:${key}`, payload.command)
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

  const hasPublications = publications.length > 0

  return (
    <Card size="sm">
      <CardHeader className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Share Codex login</CardTitle>
            <CardDescription className="text-xs">
              One command puts someone's local Codex on your plans. Their machine
              reports usage here and moves to your next usable plan when one runs
              out.
            </CardDescription>
          </div>
          {hasPublications ? (
            <div className="flex flex-wrap items-center gap-2">
              {copiedKey === `command:${POOL_KEY}` ? <CopiedPill /> : null}
              <Button
                className="shrink-0"
                disabled={Boolean(busyKey)}
                onClick={() => void handleCreateCommand('pool')}
                size="sm"
                type="button"
              >
                <Shuffle className="mr-1.5 size-3.5" />
                {busyKey === `grant:${POOL_KEY}`
                  ? 'Creating command...'
                  : 'Create login command'}
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {sharesQuery.error ? (
          <Notice tone="error">{sharesQuery.error.message}</Notice>
        ) : null}

        {sharesQuery.isPending && !sharesQuery.data ? (
          <Notice tone="default">Loading shared logins...</Notice>
        ) : null}

        {sharesQuery.data && !hasPublications ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No login is published yet. On the machine paired with this
              dashboard, publish every plan from the Codex switcher store:
            </p>
            <CommandBlock
              command={buildPublishAllLoginsCommand()}
              copied={copiedKey === 'publish-all'}
              onCopy={() => void copyText('publish-all', buildPublishAllLoginsCommand())}
            />
            <p className="text-sm text-muted-foreground">
              Or publish only the plan Codex is logged into right now:
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

        {loginCommand ? (
          <div className="space-y-2 rounded-lg border border-border px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{loginCommand.title}</p>
              <p className="text-xs text-muted-foreground">
                Single use · expires {formatTimestamp(loginCommand.expiresAt)}
              </p>
            </div>
            <CommandBlock
              command={loginCommand.command}
              copied={copiedKey === `command:${loginCommand.key}`}
              onCopy={() => void copyText(`command:${loginCommand.key}`, loginCommand.command)}
            />
            {copyError ? (
              <p className="text-xs text-muted-foreground">{copyError}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Send this to the person. They run it once, then keep{' '}
              <span className="font-mono">{buildUseLoginWatchCommand()}</span>{' '}
              running so the login stays fresh and switches plans on its own.
              Their previous Codex login is backed up.
            </p>
          </div>
        ) : null}

        {liveGrants.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {liveGrants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {describeGrant(grant)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {describeGrantActivity(grant, publications)}
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

        {hasPublications ? (
          <div className="space-y-2">
            <button
              aria-expanded={showPlans}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowPlans((value) => !value)}
              type="button"
            >
              {showPlans ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {publications.length} {publications.length === 1 ? 'plan' : 'plans'} in the pool
              {liveGrants.length > 0
                ? ` · ${liveGrants.length} ${liveGrants.length === 1 ? 'recipient' : 'recipients'}`
                : ''}
            </button>
            {showPlans ? (
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {publications.map((publication) => (
                <li
                  key={publication.accountId}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium text-foreground">
                      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{publication.email}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {publication.planType ?? 'Unknown plan'} · login updated{' '}
                      {formatRelativeTimestamp(publication.updatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {copiedKey === `command:${publication.accountId}` ? <CopiedPill /> : null}
                    <Button
                      disabled={Boolean(busyKey)}
                      onClick={() => void handleCreateCommand(publication)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {busyKey === `grant:${publication.accountId}`
                        ? 'Creating...'
                        : 'Pinned command'}
                    </Button>
                    <Button
                      className="text-muted-foreground hover:text-destructive"
                      disabled={Boolean(busyKey)}
                      onClick={() => void handleStopSharing(publication)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {busyKey === `unpublish:${publication.accountId}`
                        ? 'Stopping...'
                        : 'Stop sharing'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            ) : null}
            {showPlans ? (
            <p className="text-xs text-muted-foreground">
              Add more plans with{' '}
              <span className="font-mono">{buildPublishAllLoginsCommand()}</span> on
              the paired machine. Revoking stops updates immediately; a revoked
              machine keeps working until the tokens rotate, within about ten days.
            </p>
            ) : null}
          </div>
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
    return who ? `${who} · command waiting to be used` : 'Login command waiting to be used'
  }

  return who ?? 'Recipient'
}

function describeGrantActivity(
  grant: SharedLoginGrant,
  publications: SharedLoginPublication[],
) {
  if (grant.status === 'pending') {
    return `${grant.scope === 'pool' ? 'Auto-switching' : 'Pinned'} · created ${formatRelativeTimestamp(grant.createdAt)} · expires ${formatTimestamp(grant.expiresAt)}`
  }

  const currentEmail =
    grant.currentEmail ??
    publications.find((publication) => publication.accountId === grant.currentAccountId)?.email ??
    null
  const where = currentEmail ? `on ${currentEmail}` : 'on a shared plan'
  const mode =
    grant.scope === 'pool'
      ? `auto-switching${grant.switchCount > 0 ? `, switched ${grant.switchCount}×` : ''}`
      : 'pinned'
  const synced = grant.lastSyncedAt
    ? `last synced ${formatRelativeTimestamp(grant.lastSyncedAt)}`
    : 'never synced'

  return `${where} · ${mode} · ${synced}`
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
