import { useEffect, useState, type ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session, UserIdentity } from '@supabase/supabase-js'
import {
  AlertTriangle,
  Copy,
  LogOut,
  RefreshCcw,
  TerminalSquare,
} from 'lucide-react'

import { ThemeToggle } from '@/components/theme/theme-toggle'
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
import {
  buildConnectCommand,
  DASHBOARD_CONNECTED_QUERY_KEY,
} from '@/shared/cli'
import { formatRelativeTimestamp, formatTimestamp } from '@/shared/codex'

interface PairingCommandState {
  command: string
  expiresAt: string
  pairUrl: string
  syncCommand: string
}

export function DashboardPage() {
  const {
    isLoading: authIsLoading,
    redirectError: authRedirectError,
    session,
  } = useAuthSession()
  const [loginError, setLoginError] = useState<string | null>(null)
  const [isStartingGoogleLogin, setIsStartingGoogleLogin] = useState(false)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const [terminalCopyNotice, setTerminalCopyNotice] = useState<string | null>(null)
  const [pairingCommand, setPairingCommand] = useState<PairingCommandState | null>(
    null,
  )
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [connectedNotice, setConnectedNotice] = useState<string | null>(null)

  const accountsQuery = useQuery({
    ...dashboardAccountsQueryOptions(session?.user.id ?? 'guest'),
    enabled: Boolean(session?.user.id),
  })

  const accounts = accountsQuery.data ?? []
  const summary = buildSummary(accounts)
  const connectCommand =
    typeof window === 'undefined'
      ? ''
      : buildConnectCommand(window.location.origin)
  const googleIdentityEmail = getProviderEmail(session, 'google')
  const isGuestSession = getIsGuestSession(session)
  const canLinkGoogle = Boolean(session) && isGuestSession && !googleIdentityEmail
  const sessionLabel = isGuestSession
    ? googleIdentityEmail ?? 'Local dashboard session'
    : session?.user.email ?? 'Signed in'
  const isLoadingAccounts =
    Boolean(session) && accountsQuery.isPending && accounts.length === 0

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(DASHBOARD_CONNECTED_QUERY_KEY)) {
      return
    }

    setConnectedNotice(
      'This browser is connected to the dashboard for the current local Codex machine.',
    )
    url.searchParams.delete(DASHBOARD_CONNECTED_QUERY_KEY)
    window.history.replaceState({}, '', url.toString())
  }, [])

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

    const authOptions = {
      redirectTo: window.location.origin,
      skipBrowserRedirect: true,
    }

    const { data, error } = isGuestSession
      ? await supabase.auth.linkIdentity({
          provider: 'google',
          options: authOptions,
        })
      : await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: authOptions,
        })

    setIsStartingGoogleLogin(false)

    if (error) {
      const currentSupabaseHost = new URL(
        import.meta.env.VITE_SUPABASE_URL,
      ).host
      const providerDisabled =
        error.message.includes('Unsupported provider') ||
        error.message.includes('provider is not enabled')
      const linkingDisabled =
        error.message.includes('Manual account linking') ||
        error.message.includes('manual linking')

      setLoginError(
        providerDisabled
          ? `Google sign-in is not enabled on the Supabase project backing this app (${currentSupabaseHost}).`
          : linkingDisabled
            ? `Manual account linking is not enabled on the Supabase project backing this app (${currentSupabaseHost}).`
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
    setConnectedNotice(null)
    setTerminalCopyNotice(null)

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

  async function handleCopyTerminalCommand() {
    try {
      await navigator.clipboard.writeText(connectCommand)
      setTerminalCopyNotice('Command copied.')
    } catch {
      setTerminalCopyNotice('Copy failed. Select the command manually.')
    }
  }

  if (!supabase) {
    return (
      <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[720px]">
          <Card className="border-destructive/30 bg-destructive/10">
            <CardHeader>
              <CardTitle>Supabase env vars are missing</CardTitle>
              <CardDescription>
                Set the browser env vars before you try to sign in or pair
                Codex.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-destructive text-sm">
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
          <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-5 sm:items-center sm:px-6 lg:px-8">
            <div className="min-w-0">
              <h1 className="text-[1.7rem] font-semibold tracking-[-0.02em]">
                Codex usage
              </h1>
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
              {!authIsLoading && !session ? (
                <Button
                  disabled={isStartingGoogleLogin}
                  onClick={() => void handleGoogleSignIn()}
                  type="button"
                >
                  <GoogleIcon className="mr-2 size-4" />
                  {isStartingGoogleLogin
                    ? 'Redirecting to Google...'
                    : 'Continue with Google'}
                </Button>
              ) : null}

              <ThemeToggle className="shrink-0" />

              {session ? (
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <div className="text-right text-sm">
                    <p className="font-medium text-foreground">
                      {sessionLabel}
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
          </div>
        </header>

        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {authIsLoading ? (
            <LoadingState />
          ) : session ? (
            <div className="space-y-6">
              {connectedNotice ? (
                <InlineMessage tone="default">{connectedNotice}</InlineMessage>
              ) : null}

              <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-6">
                  {canLinkGoogle ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Link Google</CardTitle>
                        <CardDescription>
                          The dashboard already works through the local terminal
                          flow. Add Google if you want the same account to keep a
                          reusable browser sign-in.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <Button
                          disabled={isStartingGoogleLogin}
                          onClick={() => void handleGoogleSignIn()}
                          type="button"
                        >
                          <GoogleIcon className="mr-2 size-4" />
                          {isStartingGoogleLogin
                            ? 'Redirecting to Google...'
                            : 'Link Google'}
                        </Button>

                        {loginError ? (
                          <InlineMessage tone="error">{loginError}</InlineMessage>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader className="border-b border-border">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>Connect Codex</CardTitle>
                        <Button
                          className="shrink-0"
                          disabled={isGeneratingPairing}
                          onClick={() => void handleStartPairing()}
                        >
                          <TerminalSquare className="mr-2 size-4" />
                          {isGeneratingPairing
                            ? 'Creating command...'
                            : 'Create pairing command'}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">

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

                </div>

                <Card className="min-w-0">
                  <CardHeader className="border-b border-border">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-0">
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
                        className="shrink-0"
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
            </div>
          ) : (
            <div className="mx-auto max-w-[720px] space-y-4">
              {loginError ? (
                <InlineMessage tone="error">{loginError}</InlineMessage>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Connect from terminal</CardTitle>
                  <CardDescription>
                    Run one command on the machine that already has Codex. It
                    opens this dashboard in the browser and does not require
                    Google first.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {authRedirectError ? (
                    <InlineMessage tone="error">{authRedirectError}</InlineMessage>
                  ) : null}

                  <div className="rounded-lg border border-border bg-muted px-3 py-3 font-mono text-xs leading-6 text-foreground">
                    {connectCommand}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      Rerun the same command later to reopen the dashboard on
                      the same machine.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleCopyTerminalCommand()}
                      type="button"
                    >
                      <Copy className="mr-2 size-3.5" />
                      Copy
                    </Button>
                  </div>

                  {terminalCopyNotice ? (
                    <InlineMessage tone="default">{terminalCopyNotice}</InlineMessage>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function GoogleIcon(props: ComponentProps<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.56 2.68-3.86 2.68-6.62Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.34A9 9 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.2.28-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.46.35 2.84.96 4.06l3-2.34Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.5.46 3.44 1.36l2.58-2.58C13.47.92 11.43 0 9 0A9 9 0 0 0 .96 4.94l3 2.34C4.67 5.16 6.66 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-destructive/30 bg-destructive/10 text-destructive border-b px-4 py-3 text-sm sm:px-5">
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
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
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

function getAccountIdentityLines(account: DashboardAccountRow) {
  const primary = account.label ?? account.email ?? account.account_key
  const secondary = account.email
    ? account.email !== primary
      ? account.email
      : null
    : account.account_key !== primary
      ? account.account_key
      : null

  return { primary, secondary }
}

function AccountTable({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <Table className="min-w-[760px]">
      <TableHeader className="bg-muted/70">
        <TableRow className="hover:bg-muted/70">
          <TableHead className="px-4 sm:px-5">Account</TableHead>
          <TableHead>Snapshot</TableHead>
          <TableHead>5-hour</TableHead>
          <TableHead>Weekly</TableHead>
          <TableHead className="pr-4 sm:pr-5">Weekly reset</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          const identity = getAccountIdentityLines(account)

          return (
            <TableRow key={account.id}>
              <TableCell className="px-4 py-3 sm:px-5">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">{identity.primary}</p>
                  {identity.secondary ? (
                    <p className="text-sm text-muted-foreground">
                      {identity.secondary}
                    </p>
                  ) : null}
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
        const identity = getAccountIdentityLines(account)

        return (
          <div key={account.id} className="space-y-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-foreground">{identity.primary}</p>
              {identity.secondary ? (
                <p className="truncate text-sm text-muted-foreground">
                  {identity.secondary}
                </p>
              ) : null}
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

function getIsGuestSession(session: Session | null) {
  return session?.user.user_metadata?.guest === true
}

function getProviderEmail(
  session: Session | null,
  provider: UserIdentity['provider'],
) {
  const identity = session?.user.identities?.find(
    (candidate) => candidate.provider === provider,
  )
  const email = identity?.identity_data?.email

  return typeof email === 'string' ? email : null
}
