import { useEffect, useEffectEvent, useState, type ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session, UserIdentity } from '@supabase/supabase-js'
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Link2Off,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { INVALID_SESSION_MESSAGE, useAuthSession } from '@/lib/auth'
import {
  buildSummary,
  dashboardAccountsQueryOptions,
  dashboardInvitersQueryOptions,
  fetchDashboardAccounts,
  fetchDashboardInviters,
  type DashboardAccountRow,
  type DashboardInviterRow,
} from '@/lib/dashboard'
import { clientEnvError } from '@/lib/env'
import { queryClient } from '@/lib/query-client'
import { supabase } from '@/lib/supabase'
import {
  buildConnectCommand,
  DASHBOARD_CONNECTED_QUERY_KEY,
} from '@/shared/cli'
import { formatRelativeTimestamp, formatTimestamp } from '@/shared/codex'
import {
  buildDashboardAuthReturnUrl,
  getPreferredDashboardHref,
  getPreferredDashboardOrigin,
} from '@/shared/site'

interface PairingCommandState {
  command: string
  expiresAt: string
  pairUrl: string
  syncCommand: string
}

interface ShareInviteState {
  expiresAt: string
  inviteUrl: string
}

interface InvitePreviewState {
  expiresAt: string
  inviter: {
    avatarUrl: string | null
    displayName: string
    email: string | null
  }
  status: 'accepted' | 'expired' | 'pending' | 'revoked'
}

const PENDING_INVITE_TOKEN_STORAGE_KEY = 'codex-usage.pending-invite-token'
const COPY_FEEDBACK_DURATION_MS = 2000

export function DashboardPage() {
  const {
    isLoading: authIsLoading,
    redirectError: authRedirectError,
    session,
  } = useAuthSession()
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    getInitialInviteToken(),
  )
  const [loginError, setLoginError] = useState<string | null>(null)
  const [isStartingGoogleLogin, setIsStartingGoogleLogin] = useState(false)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const [isCreatingInvite, setIsCreatingInvite] = useState(false)
  const [isAcceptingInvite, setIsAcceptingInvite] = useState(false)
  const [hasAttemptedInviteAccept, setHasAttemptedInviteAccept] = useState(false)
  const [terminalCopyError, setTerminalCopyError] = useState<string | null>(null)
  const [isTerminalCommandCopied, setIsTerminalCommandCopied] = useState(false)
  const [pairingCommand, setPairingCommand] = useState<PairingCommandState | null>(
    null,
  )
  const [shareInvite, setShareInvite] = useState<ShareInviteState | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [inviteCreateError, setInviteCreateError] = useState<string | null>(null)
  const [inviteAcceptError, setInviteAcceptError] = useState<string | null>(null)
  const [invitePreview, setInvitePreview] = useState<InvitePreviewState | null>(null)
  const [invitePreviewError, setInvitePreviewError] = useState<string | null>(null)
  const [inviteNotice, setInviteNotice] = useState<string | null>(null)
  const [pairingCopyError, setPairingCopyError] = useState<string | null>(null)
  const [isPairingCommandCopied, setIsPairingCommandCopied] = useState(false)
  const [syncCommandCopyError, setSyncCommandCopyError] = useState<string | null>(
    null,
  )
  const [isSyncCommandCopied, setIsSyncCommandCopied] = useState(false)
  const [inviteCopyError, setInviteCopyError] = useState<string | null>(null)
  const [isInviteLinkCopied, setIsInviteLinkCopied] = useState(false)
  const [connectedNotice, setConnectedNotice] = useState<string | null>(null)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [unlinkingAccountId, setUnlinkingAccountId] = useState<string | null>(null)
  const showInviteLanding = Boolean(inviteToken)
  const canLoadDashboardData = Boolean(session?.user.id) && !showInviteLanding

  const accountsQuery = useQuery({
    ...dashboardAccountsQueryOptions(session?.user.id ?? 'guest'),
    enabled: canLoadDashboardData,
  })
  const invitersQuery = useQuery({
    ...dashboardInvitersQueryOptions(session?.user.id ?? 'guest'),
    enabled: canLoadDashboardData,
  })

  const accounts = accountsQuery.data ?? []
  const inviters = invitersQuery.data ?? []
  const summary = buildSummary(accounts)
  const connectCommand =
    typeof window === 'undefined'
      ? ''
      : buildConnectCommand(getPreferredDashboardOrigin(window.location.origin))
  const inviteOriginRedirectUrl =
    typeof window === 'undefined' || !inviteToken
      ? null
      : getInviteOriginRedirectUrl(window.location.href)
  const hasGoogleSession = hasSessionProvider(session, 'google')
  const googleIdentityEmail = getProviderEmail(session, 'google')
  const isGuestSession = getIsGuestSession(session)
  const canLinkGoogle = Boolean(session) && isGuestSession && !hasGoogleSession
  const canRetryInvite = Boolean(inviteToken && session?.access_token && inviteAcceptError)
  const sessionLabel = isGuestSession
    ? googleIdentityEmail ?? session?.user.email ?? 'Local dashboard session'
    : session?.user.email ?? 'Signed in'
  const sessionAvatarUrl = getSessionAvatarUrl(session)
  const primaryInviter = inviters.length === 1 ? inviters[0] : null
  const isLoadingAccounts =
    Boolean(session) && accountsQuery.isPending && accounts.length === 0
  const hasPairingDetails = Boolean(pairingError || pairingCommand)
  const hasInviteDetails = Boolean(inviteCreateError || shareInvite)
  const hasAccountsDetails = Boolean(
    accountsQuery.error || unlinkError || isLoadingAccounts || accounts.length > 0,
  )
  const acceptInviteOnAuth = useEffectEvent(() => {
    void handleAcceptInvite()
  })

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

  useEffect(() => {
    if (!isTerminalCommandCopied) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsTerminalCommandCopied(false)
    }, COPY_FEEDBACK_DURATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isTerminalCommandCopied])

  useEffect(() => {
    if (!isInviteLinkCopied) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsInviteLinkCopied(false)
    }, COPY_FEEDBACK_DURATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isInviteLinkCopied])

  useEffect(() => {
    if (!isPairingCommandCopied) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsPairingCommandCopied(false)
    }, COPY_FEEDBACK_DURATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isPairingCommandCopied])

  useEffect(() => {
    if (!isSyncCommandCopied) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsSyncCommandCopied(false)
    }, COPY_FEEDBACK_DURATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isSyncCommandCopied])

  useEffect(() => {
    if (!inviteOriginRedirectUrl) {
      return
    }

    window.location.replace(inviteOriginRedirectUrl)
  }, [inviteOriginRedirectUrl])

  useEffect(() => {
    if (!inviteToken) {
      setHasAttemptedInviteAccept(false)
      setInviteAcceptError(null)
      setInvitePreview(null)
      setInvitePreviewError(null)
      return
    }

    if (!session?.access_token) {
      setHasAttemptedInviteAccept(false)
      return
    }

    if (
      inviteOriginRedirectUrl ||
      !hasGoogleSession ||
      hasAttemptedInviteAccept
    ) {
      return
    }

    setHasAttemptedInviteAccept(true)
    acceptInviteOnAuth()
  }, [
    hasGoogleSession,
    hasAttemptedInviteAccept,
    inviteToken,
    inviteOriginRedirectUrl,
    session?.access_token,
  ])

  useEffect(() => {
    if (!inviteToken || inviteOriginRedirectUrl) {
      return
    }

    let cancelled = false

    void fetch(`/api/shares/preview?token=${encodeURIComponent(inviteToken)}`)
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | InvitePreviewState
          | { error?: string }
          | null

        if (!response.ok) {
          throw new Error(
            payload && 'error' in payload && payload.error
              ? payload.error
              : 'Unable to load invite details.',
          )
        }

        if (cancelled) {
          return
        }

        setInvitePreview(payload as InvitePreviewState)
        setInvitePreviewError(null)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setInvitePreview(null)
        setInvitePreviewError(
          error instanceof Error ? error.message : 'Unable to load invite details.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [inviteOriginRedirectUrl, inviteToken])

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

    if (inviteToken) {
      persistPendingInviteToken(inviteToken)
    } else {
      clearPendingInviteToken()
    }

    const authOptions = {
      redirectTo: buildDashboardAuthReturnUrl(window.location.origin),
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
    setInviteCreateError(null)
    setInviteAcceptError(null)
    setInviteNotice(null)
    setShareInvite(null)
    setPairingCopyError(null)
    setIsPairingCommandCopied(false)
    setSyncCommandCopyError(null)
    setIsSyncCommandCopied(false)
    setInviteCopyError(null)
    setConnectedNotice(null)
    setTerminalCopyError(null)
    setIsTerminalCommandCopied(false)
    setIsInviteLinkCopied(false)
    clearPendingInviteToken()

    if (!supabase) {
      return
    }

    const { error } = await supabase.auth.signOut()
    if (error) {
      setLoginError(error.message)
    }
  }

  async function handleInvalidSession(message = INVALID_SESSION_MESSAGE) {
    setHasAttemptedInviteAccept(false)

    if (!supabase) {
      return message
    }

    await supabase.auth.signOut({ scope: 'local' })
    return message
  }

  async function copyPairingCommandToClipboard(command: string) {
    try {
      await navigator.clipboard.writeText(command)
      setPairingCopyError(null)
      setIsPairingCommandCopied(true)
    } catch {
      setIsPairingCommandCopied(false)
      setPairingCopyError('Copy failed. Select the command manually.')
    }
  }

  async function copyInviteLinkToClipboard(inviteUrl: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setInviteCopyError(null)
      setIsInviteLinkCopied(true)
    } catch {
      setIsInviteLinkCopied(false)
      setInviteCopyError('Copy failed. Select the invite link manually.')
    }
  }

  async function handleStartPairing() {
    if (!session?.access_token) {
      setPairingError('Sign in first.')
      return
    }

    setIsGeneratingPairing(true)
    setPairingError(null)
    setPairingCopyError(null)
    setIsPairingCommandCopied(false)

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
        if (response.status === 401) {
          throw new Error(
            await handleInvalidSession(
              payload && 'error' in payload && payload.error
                ? payload.error
                : INVALID_SESSION_MESSAGE,
            ),
          )
        }

        throw new Error(
          payload && 'error' in payload && payload.error
            ? payload.error
            : 'Unable to create a pairing command.',
        )
      }

      const nextPairingCommand = payload as PairingCommandState
      setPairingCommand(nextPairingCommand)
      setSyncCommandCopyError(null)
      setIsSyncCommandCopied(false)
      await copyPairingCommandToClipboard(nextPairingCommand.command)
    } catch (error) {
      setPairingError(
        error instanceof Error ? error.message : 'Unable to create pairing.',
      )
    } finally {
      setIsGeneratingPairing(false)
    }
  }

  async function handleCreateInvite() {
    if (!session?.access_token) {
      setInviteCreateError('Sign in first.')
      return
    }

    setIsCreatingInvite(true)
    setInviteCreateError(null)
    setInviteCopyError(null)
    setIsInviteLinkCopied(false)

    try {
      const response = await fetch('/api/shares/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      const payload = (await response.json().catch(() => null)) as
        | ShareInviteState
        | { error?: string }
        | null

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            await handleInvalidSession(
              payload && 'error' in payload && payload.error
                ? payload.error
                : INVALID_SESSION_MESSAGE,
            ),
          )
        }

        throw new Error(
          payload && 'error' in payload && payload.error
            ? payload.error
            : 'Unable to create an invite link.',
        )
      }

      const nextShareInvite = payload as ShareInviteState
      setShareInvite(nextShareInvite)
      await copyInviteLinkToClipboard(nextShareInvite.inviteUrl)
    } catch (error) {
      setInviteCreateError(
        error instanceof Error ? error.message : 'Unable to create the invite.',
      )
    } finally {
      setIsCreatingInvite(false)
    }
  }

  async function handleAcceptInvite() {
    if (!inviteToken) {
      return
    }

    if (!session?.access_token) {
      setInviteAcceptError('Sign in with Google to accept this invite.')
      return
    }

    setIsAcceptingInvite(true)
    setInviteAcceptError(null)

    try {
      const response = await fetch('/api/shares/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          inviteToken,
        }),
      })

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; alreadyAccepted?: boolean }
        | null

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            await handleInvalidSession(
              payload && 'error' in payload && payload.error
                ? payload.error
                : INVALID_SESSION_MESSAGE,
            ),
          )
        }

        throw new Error(
          payload && 'error' in payload && payload.error
            ? payload.error
            : 'Unable to accept the invite.',
        )
      }

      const viewerUserId = session.user.id
      const [nextAccounts, nextInviters] = await Promise.all([
        fetchDashboardAccounts(),
        fetchDashboardInviters(),
      ])

      queryClient.setQueryData(['dashboard-accounts', viewerUserId], nextAccounts)
      queryClient.setQueryData(['dashboard-inviters', viewerUserId], nextInviters)

      clearPendingInviteToken()
      clearInviteTokenFromLocation()
      setInviteNotice(
        payload?.alreadyAccepted
          ? 'This shared dashboard is already available in your account.'
          : 'Invite accepted. Shared accounts are now visible in this dashboard.',
      )
      setInviteToken(null)
    } catch (error) {
      setInviteAcceptError(
        error instanceof Error ? error.message : 'Unable to accept the invite.',
      )
    } finally {
      setIsAcceptingInvite(false)
    }
  }

  async function handleCopyCommand() {
    if (!pairingCommand) {
      return
    }

    await copyPairingCommandToClipboard(pairingCommand.command)
  }

  async function handleCopySyncCommand() {
    if (!pairingCommand) {
      return
    }

    try {
      await navigator.clipboard.writeText(pairingCommand.syncCommand)
      setSyncCommandCopyError(null)
      setIsSyncCommandCopied(true)
    } catch {
      setIsSyncCommandCopied(false)
      setSyncCommandCopyError('Copy failed. Select the command manually.')
    }
  }

  async function handleCopyInviteLink() {
    if (!shareInvite) {
      return
    }

    await copyInviteLinkToClipboard(shareInvite.inviteUrl)
  }

  async function handleCopyTerminalCommand() {
    try {
      await navigator.clipboard.writeText(connectCommand)
      setTerminalCopyError(null)
      setIsTerminalCommandCopied(true)
    } catch {
      setIsTerminalCommandCopied(false)
      setTerminalCopyError('Copy failed. Select the command manually.')
    }
  }

  async function handleUnlinkAccount(account: DashboardAccountRow) {
    if (account.access_scope !== 'owned') {
      setUnlinkError('Only the account owner can unlink this account.')
      return
    }

    if (!session?.access_token) {
      setUnlinkError('Your session is no longer valid. Sign in again.')
      return
    }

    const identity = getAccountIdentityLines(account)
    const confirmed = window.confirm(`Unlink ${identity.primary}?`)
    if (!confirmed) {
      return
    }

    setUnlinkError(null)
    setUnlinkingAccountId(account.id)

    try {
      const response = await fetch('/api/accounts/unlink', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId: account.id,
        }),
      })

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; ok?: boolean }
        | null

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            await handleInvalidSession(
              payload && 'error' in payload && payload.error
                ? payload.error
                : INVALID_SESSION_MESSAGE,
            ),
          )
        }

        throw new Error(
          payload && 'error' in payload && payload.error
            ? payload.error
            : 'Unable to unlink this account.',
        )
      }

      await accountsQuery.refetch()
    } catch (error) {
      setUnlinkError(
        error instanceof Error ? error.message : 'Unable to unlink this account.',
      )
    } finally {
      setUnlinkingAccountId(null)
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
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      alt={sessionLabel}
                      fallback={sessionLabel}
                      size="sm"
                      src={sessionAvatarUrl}
                    />
                    <div className="text-right text-sm">
                      <p className="font-medium text-foreground">
                        {sessionLabel}
                      </p>
                      <p className="text-muted-foreground">
                        {showInviteLanding
                          ? isAcceptingInvite
                            ? 'Finishing shared access...'
                            : 'Shared invite in progress'
                          : `${summary.accountsTracked} tracked${
                              summary.accountsTracked === 1
                                ? ' account'
                                : ' accounts'
                            }`}
                      </p>
                    </div>
                  </div>
                  <Button
                    aria-label="Sign out"
                    onClick={() => void handleSignOut()}
                    size="icon"
                    title="Sign out"
                    variant="outline"
                  >
                    <LogOut className="size-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {showInviteLanding ? (
            <div className="mx-auto max-w-[720px] space-y-4">
              {loginError ? (
                <InlineMessage tone="error">{loginError}</InlineMessage>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Accept shared dashboard access</CardTitle>
                  <CardDescription>
                    Sign in with Google and this dashboard will load the same
                    Codex accounts the inviter can see.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {invitePreview ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-3">
                      <UserAvatar
                        alt={invitePreview.inviter.displayName}
                        fallback={invitePreview.inviter.displayName}
                        size="sm"
                        src={invitePreview.inviter.avatarUrl}
                      />
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-foreground">
                          Invited by {invitePreview.inviter.displayName}
                        </p>
                        {invitePreview.inviter.email &&
                        invitePreview.inviter.email !==
                          invitePreview.inviter.displayName ? (
                          <p className="truncate text-muted-foreground">
                            {invitePreview.inviter.email}
                          </p>
                        ) : null}
                        <p className="text-muted-foreground">
                          Link status: {formatInviteStatus(invitePreview.status)}
                        </p>
                      </div>
                    </div>
                  ) : inviteOriginRedirectUrl ? (
                    <InlineMessage tone="default">
                      Opening the invite on codexusage.vercel.app...
                    </InlineMessage>
                  ) : !invitePreviewError ? (
                    <InlineMessage tone="default">
                      Loading invite details...
                    </InlineMessage>
                  ) : null}
                  {session ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-3">
                      <UserAvatar
                        alt={sessionLabel}
                        fallback={sessionLabel}
                        size="sm"
                        src={sessionAvatarUrl}
                      />
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-foreground">{sessionLabel}</p>
                        <p className="text-muted-foreground">
                          {isAcceptingInvite
                            ? 'Loading shared accounts into this dashboard...'
                            : hasGoogleSession
                              ? 'Google sign-in complete.'
                              : 'Sign in with Google to finish accepting this invite.'}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {invitePreviewError ? (
                    <InlineMessage tone="error">{invitePreviewError}</InlineMessage>
                  ) : null}
                  {authRedirectError ? (
                    <InlineMessage tone="error">{authRedirectError}</InlineMessage>
                  ) : null}
                  {inviteAcceptError ? (
                    <InlineMessage tone="error">{inviteAcceptError}</InlineMessage>
                  ) : null}
                  {isAcceptingInvite ? (
                    <LoadingState />
                  ) : null}
                  {canRetryInvite ? (
                    <div>
                      <Button
                        onClick={() => void handleAcceptInvite()}
                        size="sm"
                        variant="outline"
                      >
                        Retry invite
                      </Button>
                    </div>
                  ) : null}
                  {!isAcceptingInvite ? (
                    <Button
                      disabled={
                        Boolean(inviteOriginRedirectUrl) ||
                        authIsLoading ||
                        isStartingGoogleLogin ||
                        invitePreview?.status === 'accepted' ||
                        invitePreview?.status === 'expired' ||
                        invitePreview?.status === 'revoked' ||
                        Boolean(session?.access_token && hasGoogleSession)
                      }
                      onClick={() => void handleGoogleSignIn()}
                      type="button"
                    >
                      <GoogleIcon className="mr-2 size-4" />
                      {inviteOriginRedirectUrl
                        ? 'Opening shared link...'
                        : authIsLoading
                          ? 'Checking sign-in...'
                          : isStartingGoogleLogin
                            ? 'Redirecting to Google...'
                            : session?.access_token && hasGoogleSession
                              ? 'Loading shared accounts...'
                              : 'Continue with Google'}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          ) : session ? (
            <div className="space-y-6">
              {connectedNotice ? (
                <InlineMessage tone="default">{connectedNotice}</InlineMessage>
              ) : null}
              {inviteNotice ? (
                <InlineMessage tone="default">{inviteNotice}</InlineMessage>
              ) : null}
              {inviteAcceptError ? (
                <InlineMessage tone="error">{inviteAcceptError}</InlineMessage>
              ) : null}

              <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-6">
                  {canLinkGoogle ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          {inviteToken ? 'Accept shared dashboard access' : 'Link Google'}
                        </CardTitle>
                        <CardDescription>
                          {inviteToken
                            ? 'This invite only works after you sign in with Google.'
                            : 'The dashboard already works through the local terminal flow. Add Google if you want the same account to keep a reusable browser sign-in.'}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <Button
                          disabled={Boolean(inviteOriginRedirectUrl) || isStartingGoogleLogin}
                          onClick={() => void handleGoogleSignIn()}
                          type="button"
                        >
                          <GoogleIcon className="mr-2 size-4" />
                          {inviteOriginRedirectUrl
                            ? 'Opening shared link...'
                            : isStartingGoogleLogin
                            ? 'Redirecting to Google...'
                            : inviteToken
                              ? 'Continue with Google'
                              : 'Link Google'}
                        </Button>

                        {loginError ? (
                          <InlineMessage tone="error">{loginError}</InlineMessage>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : null}

                  {inviters.length > 0 || invitersQuery.error ? (
                    <Card>
                      <CardHeader
                        className={
                          inviters.length > 0 || invitersQuery.error
                            ? 'border-b border-border'
                            : undefined
                        }
                      >
                        <CardTitle>Shared with you</CardTitle>
                        <CardDescription>
                          These people invited you to see their dashboard accounts.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {invitersQuery.error ? (
                          <InlineMessage tone="error">
                            {invitersQuery.error.message}
                          </InlineMessage>
                        ) : null}

                        {inviters.map((inviter) => (
                          <div
                            key={inviter.sharer_user_id}
                            className="flex items-center gap-3"
                          >
                            <UserAvatar
                              alt={getInviterLabel(inviter)}
                              fallback={getInviterLabel(inviter)}
                              size="sm"
                              src={inviter.sharer_avatar_url}
                            />
                            <div className="min-w-0 text-sm">
                              <p className="truncate font-medium text-foreground">
                                {getInviterLabel(inviter)}
                              </p>
                              {inviter.sharer_email &&
                              inviter.sharer_email !== getInviterLabel(inviter) ? (
                                <p className="truncate text-muted-foreground">
                                  {inviter.sharer_email}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader
                      className={hasInviteDetails ? 'border-b border-border' : undefined}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>Invite viewers</CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                          {isInviteLinkCopied ? <CopiedPill /> : null}
                          <Button
                            className="shrink-0"
                            disabled={isCreatingInvite}
                            onClick={() => void handleCreateInvite()}
                            type="button"
                          >
                            <Link2 className="mr-2 size-4" />
                            {isCreatingInvite ? 'Creating link...' : 'Create invite link'}
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    {hasInviteDetails ? (
                      <CardContent className="space-y-4">
                        {inviteCreateError ? (
                          <InlineMessage tone="error">{inviteCreateError}</InlineMessage>
                        ) : null}

                        {shareInvite ? (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <label className="block text-sm font-medium text-foreground">
                                Share this link
                              </label>
                              <p className="text-xs text-muted-foreground">
                                Expires {formatTimestamp(shareInvite.expiresAt)}
                              </p>
                            </div>
                            <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 text-foreground">
                              <Button
                                aria-label={
                                  isInviteLinkCopied
                                    ? 'Invite link copied'
                                    : 'Copy invite link'
                                }
                                className="absolute top-2 right-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
                                onClick={() => void handleCopyInviteLink()}
                                size="icon-sm"
                                title={
                                  isInviteLinkCopied
                                    ? 'Invite link copied'
                                    : 'Copy invite link'
                                }
                                type="button"
                                variant="ghost"
                              >
                                {isInviteLinkCopied ? (
                                  <Check className="size-3.5" />
                                ) : (
                                  <Copy className="size-3.5" />
                                )}
                              </Button>
                              {shareInvite.inviteUrl}
                            </div>
                            {inviteCopyError ? (
                              <p className="text-xs text-muted-foreground">
                                {inviteCopyError}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </CardContent>
                    ) : null}
                  </Card>

                  <Card>
                    <CardHeader
                      className={hasPairingDetails ? 'border-b border-border' : undefined}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>Connect Codex</CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                          {isPairingCommandCopied ? <CopiedPill /> : null}
                          <Button
                            className="shrink-0"
                            disabled={isGeneratingPairing}
                            onClick={() => void handleStartPairing()}
                            type="button"
                          >
                            <TerminalSquare className="mr-2 size-4" />
                            {isGeneratingPairing
                              ? 'Creating command...'
                              : 'Create pairing command'}
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    {hasPairingDetails ? (
                      <CardContent className="space-y-4">
                        {pairingError ? (
                          <InlineMessage tone="error">{pairingError}</InlineMessage>
                        ) : null}

                        {pairingCommand ? (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <label className="block text-sm font-medium text-foreground">
                                Run this on the local machine
                              </label>
                              <p className="text-xs text-muted-foreground">
                                Expires {formatTimestamp(pairingCommand.expiresAt)}
                              </p>
                            </div>
                            <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 text-foreground">
                              <Button
                                aria-label={
                                  isPairingCommandCopied
                                    ? 'Command copied'
                                    : 'Copy command'
                                }
                                className="absolute top-2 right-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
                                onClick={() => void handleCopyCommand()}
                                size="icon-sm"
                                title={
                                  isPairingCommandCopied
                                    ? 'Command copied'
                                    : 'Copy command'
                                }
                                type="button"
                                variant="ghost"
                              >
                                {isPairingCommandCopied ? (
                                  <Check className="size-3.5" />
                                ) : (
                                  <Copy className="size-3.5" />
                                )}
                              </Button>
                              {pairingCommand.command}
                            </div>
                            {pairingCopyError ? (
                              <p className="text-xs text-muted-foreground">
                                {pairingCopyError}
                              </p>
                            ) : null}
                            <div className="space-y-2 border-t border-border pt-3">
                              <label className="block text-sm font-medium text-foreground">
                                Keep this running for live updates
                              </label>
                              <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 text-foreground">
                                <Button
                                  aria-label={
                                    isSyncCommandCopied
                                      ? 'Command copied'
                                      : 'Copy command'
                                  }
                                  className="absolute top-2 right-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
                                  onClick={() => void handleCopySyncCommand()}
                                  size="icon-sm"
                                  title={
                                    isSyncCommandCopied
                                      ? 'Command copied'
                                      : 'Copy command'
                                  }
                                  type="button"
                                  variant="ghost"
                                >
                                  {isSyncCommandCopied ? (
                                    <Check className="size-3.5" />
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                </Button>
                                {pairingCommand.syncCommand}
                              </div>
                              {syncCommandCopyError ? (
                                <p className="text-xs text-muted-foreground">
                                  {syncCommandCopyError}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </CardContent>
                    ) : null}
                  </Card>

                </div>

                <Card className="min-w-0">
                  <CardHeader
                    className={hasAccountsDetails ? 'border-b border-border' : undefined}
                  >
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle>Accounts you can view</CardTitle>
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
                  {hasAccountsDetails ? (
                    <CardContent className="px-0 py-0">
                      {accountsQuery.error ? (
                        <ErrorBanner message={accountsQuery.error.message} />
                      ) : null}
                      {unlinkError ? (
                        <div className="px-4 pt-4 sm:px-5">
                          <InlineMessage tone="error">{unlinkError}</InlineMessage>
                        </div>
                      ) : null}
                      {isLoadingAccounts ? <LoadingRows /> : null}
                      {!isLoadingAccounts && accounts.length === 0 ? (
                        <EmptyState />
                      ) : null}
                      {accounts.length > 0 ? (
                        <>
                          <div className="md:hidden">
                            <AccountSummaryList
                              accounts={accounts}
                              primaryInviter={primaryInviter}
                              onUnlinkAccount={(account) =>
                                void handleUnlinkAccount(account)
                              }
                              unlinkingAccountId={unlinkingAccountId}
                            />
                          </div>
                          <div className="hidden md:block">
                            <AccountTable
                              accounts={accounts}
                              primaryInviter={primaryInviter}
                              onUnlinkAccount={(account) =>
                                void handleUnlinkAccount(account)
                              }
                              unlinkingAccountId={unlinkingAccountId}
                            />
                          </div>
                        </>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              </div>
            </div>
          ) : authIsLoading ? (
            <LoadingState />
          ) : (
            <div className="mx-auto max-w-[720px] space-y-4">
              {loginError ? (
                <InlineMessage tone="error">{loginError}</InlineMessage>
              ) : null}

              <section className="space-y-4">
                <h2 className="text-2xl font-semibold tracking-[-0.02em]">
                  Connect from terminal
                </h2>

                {authRedirectError ? (
                  <InlineMessage tone="error">{authRedirectError}</InlineMessage>
                ) : null}

                <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 text-foreground">
                  <Button
                    aria-label={
                      isTerminalCommandCopied ? 'Command copied' : 'Copy command'
                    }
                    className="absolute top-2 right-2"
                    onClick={() => void handleCopyTerminalCommand()}
                    size="icon-sm"
                    title={
                      isTerminalCommandCopied ? 'Command copied' : 'Copy command'
                    }
                    type="button"
                    variant="ghost"
                  >
                    {isTerminalCommandCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                  {connectCommand}
                </div>

                {terminalCopyError ? (
                  <InlineMessage tone="error">{terminalCopyError}</InlineMessage>
                ) : null}
              </section>
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

function CopiedPill() {
  return (
    <span
      aria-live="polite"
      className="inline-flex h-6 items-center rounded-full border px-2.5 text-[0.72rem] font-medium motion-safe:animate-in motion-safe:fade-in"
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
  return null
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

function AccountTable({
  accounts,
  primaryInviter,
  onUnlinkAccount,
  unlinkingAccountId,
}: {
  accounts: DashboardAccountRow[]
  primaryInviter: DashboardInviterRow | null
  onUnlinkAccount: (account: DashboardAccountRow) => void
  unlinkingAccountId: string | null
}) {
  return (
    <Table className="min-w-[940px]">
      <TableHeader className="bg-muted/70">
        <TableRow className="hover:bg-muted/70">
          <TableHead className="px-4 sm:px-5">Account</TableHead>
          <TableHead>Snapshot</TableHead>
          <TableHead>5-hour</TableHead>
          <TableHead>5-hour reset</TableHead>
          <TableHead>Weekly</TableHead>
          <TableHead>Weekly reset</TableHead>
          <TableHead className="w-12 px-4 sm:px-5">
            <span className="sr-only">Unlink</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          const identity = getAccountIdentityLines(account)
          const isOwnedAccount = account.access_scope === 'owned'
          const isUnlinking = unlinkingAccountId === account.id

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
                  {!isOwnedAccount ? (
                    <SharedAccessNote inviter={primaryInviter} />
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
                <ResetTime value={account.primary_resets_at} />
              </TableCell>
              <TableCell>
                {percentLabel(account.secondary_remaining_percent)}
              </TableCell>
              <TableCell>
                <ResetTime value={account.secondary_resets_at} />
              </TableCell>
              <TableCell className="px-4 text-right sm:px-5">
                {isOwnedAccount ? (
                  <UnlinkAccountButton
                    disabled={Boolean(unlinkingAccountId)}
                    isUnlinking={isUnlinking}
                    onClick={() => onUnlinkAccount(account)}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function AccountSummaryList({
  accounts,
  primaryInviter,
  onUnlinkAccount,
  unlinkingAccountId,
}: {
  accounts: DashboardAccountRow[]
  primaryInviter: DashboardInviterRow | null
  onUnlinkAccount: (account: DashboardAccountRow) => void
  unlinkingAccountId: string | null
}) {
  return (
    <div className="divide-y divide-border">
      {accounts.map((account) => {
        const identity = getAccountIdentityLines(account)
        const isOwnedAccount = account.access_scope === 'owned'
        const isUnlinking = unlinkingAccountId === account.id

        return (
          <div key={account.id} className="space-y-3 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground">{identity.primary}</p>
                {identity.secondary ? (
                  <p className="truncate text-sm text-muted-foreground">
                    {identity.secondary}
                  </p>
                ) : null}
                {!isOwnedAccount ? (
                  <SharedAccessNote inviter={primaryInviter} />
                ) : null}
              </div>
              {isOwnedAccount ? (
                <UnlinkAccountButton
                  disabled={Boolean(unlinkingAccountId)}
                  isUnlinking={isUnlinking}
                  onClick={() => onUnlinkAccount(account)}
                />
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
                label="5-hour resets in"
                value={formatResetCountdown(account.primary_resets_at)}
              />
              <MetaField
                label="5-hour resets at"
                value={formatTimestamp(account.primary_resets_at)}
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

function ResetTime({ value }: { value: Date | string | null | undefined }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-foreground">{formatTimestamp(value)}</p>
      <p className="text-sm text-muted-foreground">
        {formatResetCountdown(value)}
      </p>
    </div>
  )
}

function SharedAccessNote({
  inviter,
}: {
  inviter: DashboardInviterRow | null
}) {
  if (!inviter) {
    return <p className="text-sm text-muted-foreground">Shared with you</p>
  }

  const inviterLabel = getInviterLabel(inviter)

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <UserAvatar
        alt={inviterLabel}
        fallback={inviterLabel}
        size="xs"
        src={inviter.sharer_avatar_url}
      />
      <span className="truncate">Invited by {inviterLabel}</span>
    </div>
  )
}

function UserAvatar({
  alt,
  fallback,
  size,
  src,
}: {
  alt: string
  fallback: string
  size: 'xs' | 'sm'
  src: string | null
}) {
  const sizeClassName = size === 'xs' ? 'size-5 text-[10px]' : 'size-8 text-xs'

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted font-medium text-muted-foreground ${sizeClassName}`}
      title={alt}
    >
      {src ? (
        <img alt={alt} className="size-full object-cover" src={src} />
      ) : (
        <span>{getAvatarInitials(fallback)}</span>
      )}
    </div>
  )
}

function UnlinkAccountButton({
  disabled,
  isUnlinking,
  onClick,
}: {
  disabled: boolean
  isUnlinking: boolean
  onClick: () => void
}) {
  const label = isUnlinking ? 'Unlinking account' : 'Unlink account'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="text-muted-foreground hover:text-destructive"
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          title={label}
          type="button"
          variant="ghost"
        >
          <Link2Off className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
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

  if (typeof email === 'string') {
    return email
  }

  return hasSessionProvider(session, provider) ? session?.user.email ?? null : null
}

function hasSessionProvider(
  session: Session | null,
  provider: UserIdentity['provider'],
) {
  if (session?.user.app_metadata?.provider === provider) {
    return true
  }

  const providers = Array.isArray(session?.user.app_metadata?.providers)
    ? session.user.app_metadata.providers
    : []
  if (providers.includes(provider)) {
    return true
  }

  return (
    session?.user.identities?.some((identity) => identity.provider === provider) ??
    false
  )
}

function getSessionAvatarUrl(session: Session | null) {
  const avatarCandidates = [
    session?.user.user_metadata?.avatar_url,
    session?.user.user_metadata?.picture,
    ...(
      session?.user.identities?.flatMap((identity) => [
        identity.identity_data?.avatar_url,
        identity.identity_data?.picture,
      ]) ?? []
    ),
  ]

  const avatarUrl = avatarCandidates.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )

  return avatarUrl ?? null
}

function getInviterLabel(inviter: DashboardInviterRow) {
  return inviter.sharer_display_name ?? inviter.sharer_email ?? 'Unknown inviter'
}

function getAvatarInitials(value: string) {
  const words = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) {
    return '?'
  }

  if (words.length === 1) {
    return words[0].slice(0, 1).toUpperCase()
  }

  return `${words[0].slice(0, 1)}${words[1].slice(0, 1)}`.toUpperCase()
}

function formatInviteStatus(status: InvitePreviewState['status']) {
  switch (status) {
    case 'accepted':
      return 'Already used'
    case 'expired':
      return 'Expired'
    case 'revoked':
      return 'Revoked'
    default:
      return 'Ready'
  }
}

function getInviteTokenFromLocation() {
  if (typeof window === 'undefined') {
    return null
  }

  const inviteToken = new URL(window.location.href).searchParams.get('invite')
  return inviteToken?.trim() ? inviteToken : null
}

function getInitialInviteToken() {
  return getInviteTokenFromLocation() ?? getPendingInviteTokenFromAuthRedirect()
}

function getInviteOriginRedirectUrl(currentHref: string) {
  const nextHref = getPreferredDashboardHref(currentHref)
  return nextHref === currentHref ? null : nextHref
}

function getPendingInviteTokenFromAuthRedirect() {
  if (typeof window === 'undefined' || !hasAuthRedirectParams(window.location.href)) {
    return null
  }

  return getPendingInviteToken()
}

function getPendingInviteToken() {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const inviteToken = window.sessionStorage.getItem(
      PENDING_INVITE_TOKEN_STORAGE_KEY,
    )
    return inviteToken?.trim() ? inviteToken : null
  } catch {
    return null
  }
}

function persistPendingInviteToken(inviteToken: string) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.setItem(PENDING_INVITE_TOKEN_STORAGE_KEY, inviteToken)
  } catch {
    // Ignore storage write failures and fall back to the bare auth redirect.
  }
}

function clearPendingInviteToken() {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.removeItem(PENDING_INVITE_TOKEN_STORAGE_KEY)
  } catch {
    // Ignore storage clear failures.
  }
}

function hasAuthRedirectParams(currentHref: string) {
  const url = new URL(currentHref)

  return (
    url.searchParams.has('code') ||
    url.searchParams.has('token_hash') ||
    url.searchParams.has('type')
  )
}

function clearInviteTokenFromLocation() {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  if (!url.searchParams.has('invite')) {
    return
  }

  url.searchParams.delete('invite')
  window.history.replaceState(window.history.state, '', url.toString())
}
