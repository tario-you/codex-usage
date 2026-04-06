import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  LogOut,
  RefreshCcw,
  TerminalSquare,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuthSession } from '@/lib/auth'
import {
  buildSummary,
  dashboardAccountsQueryOptions,
  type DashboardAccountRow,
} from '@/lib/dashboard'
import { clientEnvError } from '@/lib/env'
import { supabase } from '@/lib/supabase'
import { formatRelativeTimestamp, formatTimestamp } from '@/shared/codex'

interface PairingCommandState {
  command: string
  expiresAt: string
  pairUrl: string
  syncCommand: string
}

export function DashboardPage() {
  const { isLoading: authIsLoading, session } = useAuthSession()
  const [loginError, setLoginError] = useState<string | null>(null)
  const [isStartingGoogleLogin, setIsStartingGoogleLogin] = useState(false)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const [pairingCommand, setPairingCommand] = useState<PairingCommandState | null>(
    null,
  )
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)

  const accountsQuery = useQuery({
    ...dashboardAccountsQueryOptions(session?.user.id ?? 'guest'),
    enabled: Boolean(session?.user.id),
  })

  const accounts = accountsQuery.data ?? []
  const summary = buildSummary(accounts)
  const isLoadingAccounts =
    Boolean(session) && accountsQuery.isPending && accounts.length === 0

  async function handleGoogleSignIn() {
    setLoginError(null)

    if (!supabase) {
      setLoginError(
        clientEnvError ??
          'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      )
      return
    }

    setIsStartingGoogleLogin(true)

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        skipBrowserRedirect: true,
      },
    })

    setIsStartingGoogleLogin(false)

    if (error) {
      const currentSupabaseHost = new URL(
        import.meta.env.VITE_SUPABASE_URL,
      ).host
      const providerDisabled =
        error.message.includes('Unsupported provider') ||
        error.message.includes('provider is not enabled')

      setLoginError(
        providerDisabled
          ? `Google sign-in is not enabled on the Supabase project backing this app (${currentSupabaseHost}).`
          : error.message,
      )
      return
    }

    if (!data.url) {
      setLoginError('Supabase did not return a Google redirect URL.')
      return
    }

    window.location.assign(data.url)
  }

  async function handleSignOut() {
    setPairingCommand(null)
    setPairingError(null)
    setCopyNotice(null)

    if (!supabase) {
      return
    }

    const { error } = await supabase.auth.signOut()
    if (error) {
      setLoginError(error.message)
    }
  }

  async function handleStartPairing() {
    if (!session?.access_token) {
      setPairingError('Sign in first.')
      return
    }

    setIsGeneratingPairing(true)
    setPairingError(null)

    try {
      const response = await fetch('/api/pair/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      const payload = (await response.json().catch(() => null)) as
        | PairingCommandState
        | { error?: string }
        | null

      if (!response.ok) {
        throw new Error(
          payload && 'error' in payload && payload.error
            ? payload.error
            : 'Unable to create a pairing command.',
        )
      }

      setPairingCommand(payload as PairingCommandState)
      setCopyNotice(null)
    } catch (error) {
      setPairingError(
        error instanceof Error ? error.message : 'Unable to create pairing.',
      )
    } finally {
      setIsGeneratingPairing(false)
    }
  }

  async function handleCopyCommand() {
    if (!pairingCommand) {
      return
    }

    try {
      await navigator.clipboard.writeText(pairingCommand.command)
      setCopyNotice('Command copied.')
    } catch {
      setCopyNotice('Copy failed. Select the command manually.')
    }
  }

  if (!supabase) {
    return (
      <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[720px]">
          <Card className="border border-[#e1c7bf] bg-[#f7ebe7]">
            <CardHeader>
              <CardTitle>Supabase env vars are missing</CardTitle>
              <CardDescription>
                Set the browser env vars before you try to sign in or pair
                Codex.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-[#7b4337]">
              {clientEnvError ??
                'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'}
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1240px] flex-col">
        <header className="border-b border-border bg-card">
          <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <div>
              <h1 className="text-[1.7rem] font-semibold tracking-[-0.02em]">
                Codex usage
              </h1>
            </div>

            {session ? (
              <div className="flex items-center gap-3">
                <div className="text-right text-sm">
                  <p className="font-medium text-foreground">
                    {session.user.email ?? 'Signed in'}
                  </p>
                  <p className="text-muted-foreground">
                    {summary.accountsTracked} tracked
                    {summary.accountsTracked === 1 ? ' account' : ' accounts'}
                  </p>
                </div>
                <Button variant="outline" onClick={() => void handleSignOut()}>
                  <LogOut className="mr-2 size-4" />
                  Sign out
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {authIsLoading ? (
            <LoadingState />
          ) : session ? (
            <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Connect Codex</CardTitle>
                    <CardDescription>
                      Create a one-time command, run it on the machine that
                      already has Codex, and the sync token gets stored there.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Button
                      className="w-full justify-center"
                      disabled={isGeneratingPairing}
                      onClick={() => void handleStartPairing()}
                    >
                      <TerminalSquare className="mr-2 size-4" />
                      {isGeneratingPairing
                        ? 'Creating command...'
                        : 'Create pairing command'}
                    </Button>

                    {pairingError ? (
                      <InlineMessage tone="error">{pairingError}</InlineMessage>
                    ) : null}

                    {pairingCommand ? (
                      <div className="space-y-3">
                        <label className="block text-sm font-medium text-foreground">
                          Run this on the local machine
                        </label>
                        <div className="rounded-lg border border-border bg-muted px-3 py-3 font-mono text-xs leading-6 text-foreground">
                          {pairingCommand.command}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">
                            Expires {formatTimestamp(pairingCommand.expiresAt)}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleCopyCommand()}
                          >
                            <Copy className="mr-2 size-3.5" />
                            Copy
                          </Button>
                        </div>
                        {copyNotice ? (
                          <p className="text-xs text-muted-foreground">
                            {copyNotice}
                          </p>
                        ) : null}
                        <div className="space-y-2 border-t border-border pt-3">
                          <label className="block text-sm font-medium text-foreground">
                            Keep this running for live updates
                          </label>
                          <div className="rounded-lg border border-border bg-muted px-3 py-3 font-mono text-xs leading-6 text-foreground">
                            {pairingCommand.syncCommand}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>What happens next</CardTitle>
                    <CardDescription>
                      The command opens local Codex access, performs the first
                      snapshot, and stores a device token under the same Codex
                      home on that machine.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-muted-foreground">
                    <p>1. Run the generated command where Codex is installed.</p>
                    <p>2. If Codex is not logged in there, run `codex login` once.</p>
                    <p>
                      3. Keep the generated sync command running when you want live
                      updates after the first pair.
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card className="min-w-0">
                <CardHeader className="border-b border-border">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <CardTitle>Your synced accounts</CardTitle>
                      <CardDescription>
                        Latest sync{' '}
                        {summary.mostRecentSync
                          ? formatRelativeTimestamp(summary.mostRecentSync)
                          : 'has not happened yet'}
                        .
                        {summary.staleAccounts > 0
                          ? ` ${summary.staleAccounts} stale ${
                              summary.staleAccounts === 1 ? 'account' : 'accounts'
                            }.`
                          : ''}
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => void accountsQuery.refetch()}
                    >
                      <RefreshCcw className="mr-2 size-4" />
                      Refresh
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="px-0 py-0">
                  {accountsQuery.error ? (
                    <ErrorBanner message={accountsQuery.error.message} />
                  ) : null}
                  {isLoadingAccounts ? <LoadingRows /> : null}
                  {!isLoadingAccounts && accounts.length === 0 ? (
                    <EmptyState />
                  ) : null}
                  {accounts.length > 0 ? (
                    <>
                      <div className="md:hidden">
                        <AccountSummaryList accounts={accounts} />
                      </div>
                      <div className="hidden md:block">
                        <AccountTable accounts={accounts} />
                      </div>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="mx-auto grid max-w-[960px] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Card>
                <CardHeader>
                  <CardTitle>Sign in with Google</CardTitle>
                  <CardDescription>
                    Use Google through Supabase Auth. Pairing commands become
                    available as soon as the OAuth session comes back to this site.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button
                    disabled={isStartingGoogleLogin}
                    onClick={() => void handleGoogleSignIn()}
                    type="button"
                  >
                    <ExternalLink className="mr-2 size-4" />
                    {isStartingGoogleLogin
                      ? 'Redirecting to Google...'
                      : 'Continue with Google'}
                  </Button>

                  {loginError ? (
                    <InlineMessage className="mt-4" tone="error">
                      {loginError}
                    </InlineMessage>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Pairing shape</CardTitle>
                  <CardDescription>
                    This stays website-first. The only local step is one CLI
                    command that uses the user&apos;s existing Codex install.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>1. Continue with Google here.</p>
                  <p>2. Generate the pairing command.</p>
                  <p>3. Run it where Codex is already installed.</p>
                  <p>4. Refresh this page after the first snapshot lands.</p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-b border-[#e1c7bf] bg-[#f7ebe7] px-4 py-3 text-sm text-[#7b4337] sm:px-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">Dashboard data is not ready yet.</p>
          <p>{message}</p>
        </div>
      </div>
    </div>
  )
}

function InlineMessage({
  children,
  className,
  tone,
}: {
  children: string
  className?: string
  tone: 'default' | 'error'
}) {
  const toneClassName =
    tone === 'error'
      ? 'border-[#e1c7bf] bg-[#f7ebe7] text-[#7b4337]'
      : 'border-border bg-muted text-foreground'

  return (
    <div
      className={`${className ?? ''} rounded-lg border px-3 py-2 text-sm ${toneClassName}`.trim()}
    >
      {children}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="h-32 animate-pulse rounded-lg bg-muted" />
      <div className="h-32 animate-pulse rounded-lg bg-muted" />
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      <div className="h-10 animate-pulse rounded-sm bg-muted" />
      <div className="h-24 animate-pulse rounded-sm bg-muted" />
      <div className="h-24 animate-pulse rounded-sm bg-muted" />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="px-4 py-8 sm:px-5">
      <h3 className="text-base font-semibold text-foreground">
        No Codex snapshots yet
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Generate the pairing command, run it on the machine that already has
        Codex, and the account list will populate after the first sync.
      </p>
    </div>
  )
}

function AccountTable({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <Table className="min-w-[760px]">
      <TableHeader className="bg-[#f7f3eb]">
        <TableRow className="hover:bg-[#f7f3eb]">
          <TableHead className="px-4 sm:px-5">Account</TableHead>
          <TableHead>Snapshot</TableHead>
          <TableHead>5-hour</TableHead>
          <TableHead>Weekly</TableHead>
          <TableHead className="pr-4 sm:pr-5">Weekly reset</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          return (
            <TableRow key={account.id}>
              <TableCell className="px-4 py-3 sm:px-5">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {account.label ?? account.account_key}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {account.email ?? account.account_key}
                  </p>
                </div>
              </TableCell>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {formatRelativeTimestamp(account.last_snapshot_at)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatTimestamp(account.last_snapshot_at)}
                  </p>
                </div>
              </TableCell>
              <TableCell>{percentLabel(account.primary_remaining_percent)}</TableCell>
              <TableCell>
                {percentLabel(account.secondary_remaining_percent)}
              </TableCell>
              <TableCell className="pr-4 sm:pr-5">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {formatTimestamp(account.secondary_resets_at)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatResetCountdown(account.secondary_resets_at)}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function AccountSummaryList({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <div className="divide-y divide-border">
      {accounts.map((account) => {
        return (
          <div key={account.id} className="space-y-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {account.label ?? account.account_key}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {account.email ?? account.account_key}
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <MetaField
                label="Snapshot"
                value={formatRelativeTimestamp(account.last_snapshot_at)}
              />
              <MetaField
                label="5-hour"
                value={percentLabel(account.primary_remaining_percent)}
              />
              <MetaField
                label="Weekly"
                value={percentLabel(account.secondary_remaining_percent)}
              />
              <MetaField
                label="Weekly resets in"
                value={formatResetCountdown(account.secondary_resets_at)}
              />
              <MetaField
                label="Weekly resets at"
                value={formatTimestamp(account.secondary_resets_at)}
              />
            </dl>
          </div>
        )
      })}
    </div>
  )
}

function MetaField({
  label,
  monospace = false,
  value,
}: {
  label: string
  monospace?: boolean
  value: string
}) {
  return (
    <div className="space-y-1">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd
        className={`text-muted-foreground ${monospace ? 'break-all font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

function percentLabel(value: number | null) {
  return value == null ? 'N/A' : `${value}%`
}

function formatResetCountdown(value: Date | string | null | undefined) {
  if (!value) {
    return 'N/A'
  }

  const resetAt = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(resetAt.getTime())) {
    return 'N/A'
  }

  const remainingMs = Math.max(0, resetAt.getTime() - Date.now())
  const totalMinutes = Math.floor(remainingMs / 60000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60

  const dayLabel = days === 1 ? 'Day' : 'Days'
  const hourLabel = hours === 1 ? 'Hour' : 'Hours'
  const minuteLabel = minutes === 1 ? 'Minute' : 'Minutes'

  return `${days} ${dayLabel} ${hours} ${hourLabel} ${minutes} ${minuteLabel}`
}
