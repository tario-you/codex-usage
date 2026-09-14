import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  nextWeeklyReset,
  projectRunOut,
  projectedRemainingAt,
  type UsageProjection,
} from './usage-projection'
import {
  formatSpanShort,
  inactivityStretches,
  readingAtX,
  stretchAt,
  type ChartHoverDomain,
} from './usage-history-hover'
import { useQuery } from '@tanstack/react-query'
import type { Session, UserIdentity } from '@supabase/supabase-js'
import {
  Pencil,
  Plus,
  Trash2,
  CircleHelp,
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
  isClaudeAccount,
  buildSummary,
  dashboardAccountsQueryOptions,
  dashboardInvitersQueryOptions,
  dashboardWeeklyUsageHistoryQueryOptions,
  dashboardWeeklyUsageRanges,
  fetchDashboardAccounts,
  fetchDashboardInviters,
  getDashboardWeeklyUsageRangeDays,
  type DashboardAccountRow,
  type DashboardInviterRow,
  type DashboardWeeklyUsageHistoryPoint,
  type DashboardWeeklyUsageRange,
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
  getRateLimitWindows,
  type RateLimitWindowKey,
} from '@/shared/rate-limit-windows'
import {
  buildDashboardAuthReturnUrl,
  getPreferredDashboardHref,
  getPreferredDashboardOrigin,
} from '@/shared/site'

import { ResetPlanPanel } from './reset-plan-panel'
import { NoteEditor, NoteSecret } from './account-notes'
import { RepairSignInsBanner } from './repair-signins'
import { expiredEmailSet, useRepairState } from './repair-signins-state'
import { noteKey, useAccountNotes, type AccountNotesController } from './account-notes-state'
import { SharedLoginPanel } from './shared-login-panel'
import { GettingStartedPanel } from './getting-started-panel'
import { SwitchHistoryPanel } from './switch-history-panel'
import { RemainingPercentageEditor } from './remaining-percentage-editor'

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
  const [showGuide, setShowGuide] = useState(false)
  const accountNotes = useAccountNotes({ onInvalidSession: handleInvalidSession, session })
  const repairState = useRepairState(session)
  const expiredEmails = expiredEmailSet(repairState.data)
  const [guideHidden, setGuideHidden] = useState(false)
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
  const [usageOverrideError, setUsageOverrideError] = useState<string | null>(null)
  const [savingUsageOverride, setSavingUsageOverride] = useState<string | null>(
    null,
  )
  const [weeklyUsageRange, setWeeklyUsageRange] =
    useState<DashboardWeeklyUsageRange>('7d')
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
  const weeklyUsageHistoryQuery = useQuery({
    ...dashboardWeeklyUsageHistoryQueryOptions(
      session?.user.id ?? 'guest',
      weeklyUsageRange,
    ),
    enabled: canLoadDashboardData,
  })

  const accounts = accountsQuery.data ?? []
  const inviters = invitersQuery.data ?? []
  const weeklyUsageHistory = weeklyUsageHistoryQuery.data ?? []
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
  const hasAccountsDetails = Boolean(
    accountsQuery.error || unlinkError || isLoadingAccounts || accounts.length > 0,
  )
  const guideVisible =
    showGuide || (!isLoadingAccounts && accounts.length === 0 && !guideHidden)
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

      await Promise.all([
        accountsQuery.refetch(),
        weeklyUsageHistoryQuery.refetch(),
      ])
    } catch (error) {
      setUnlinkError(
        error instanceof Error ? error.message : 'Unable to unlink this account.',
      )
    } finally {
      setUnlinkingAccountId(null)
    }
  }

  async function handleSaveUsageOverride(
    account: DashboardAccountRow,
    windowKey: RateLimitWindowKey,
    remainingPercent: number,
  ) {
    if (account.access_scope !== 'owned') {
      setUsageOverrideError('Only the account owner can edit this percentage.')
      return false
    }

    if (!session?.access_token) {
      setUsageOverrideError('Your session is no longer valid. Sign in again.')
      return false
    }

    const overrideKey = `${account.id}:${windowKey}`
    setUsageOverrideError(null)
    setSavingUsageOverride(overrideKey)

    try {
      const response = await fetch('/api/accounts/usage-override', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId: account.id,
          remainingPercent,
          windowKey,
        }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; ok?: boolean }
        | null

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            await handleInvalidSession(
              payload?.error ?? INVALID_SESSION_MESSAGE,
            ),
          )
        }

        throw new Error(payload?.error ?? 'Unable to update the percentage.')
      }

      await accountsQuery.refetch()
      return true
    } catch (error) {
      setUsageOverrideError(
        error instanceof Error
          ? error.message
          : 'Unable to update the percentage.',
      )
      return false
    } finally {
      setSavingUsageOverride(null)
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
        <header className="border-b border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-[-0.01em]">
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

              {session && !showInviteLanding ? (
                <div className="flex items-center gap-2">
                  <Button
                    aria-pressed={guideVisible}
                    onClick={() => {
                      setGuideHidden(false)
                      setShowGuide((value) => !value)
                    }}
                    size="sm"
                    title="What each button does"
                    type="button"
                    variant="ghost"
                  >
                    <CircleHelp className="mr-1.5 size-3.5" />
                    How it works
                  </Button>
                  <Button
                    disabled={isGeneratingPairing}
                    onClick={() => void handleStartPairing()}
                    size="sm"
                    title="Show a machine's own Codex usage here. This does not sign anyone into your plans."
                    type="button"
                    variant="outline"
                  >
                    <TerminalSquare className="mr-1.5 size-3.5" />
                    {isGeneratingPairing ? 'Creating...' : 'Add a machine'}
                  </Button>
                  <Button
                    disabled={isCreatingInvite}
                    onClick={() => void handleCreateInvite()}
                    size="sm"
                    title="Get a view-only link. They see your plans and cannot use them."
                    type="button"
                    variant="outline"
                  >
                    <Link2 className="mr-1.5 size-3.5" />
                    {isCreatingInvite ? 'Creating...' : 'Invite a viewer'}
                  </Button>
                  {isPairingCommandCopied || isInviteLinkCopied || isSyncCommandCopied ? (
                    <CopiedPill />
                  ) : null}
                </div>
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
                    <div className="text-right text-xs">
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

        <div className="flex-1 px-4 py-3 sm:px-6 lg:px-8">
          {showInviteLanding ? (
            <div className="mx-auto max-w-[720px] space-y-4">
              {loginError ? (
                <InlineMessage tone="error">{loginError}</InlineMessage>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Accept shared dashboard access</CardTitle>
                  <CardDescription>
                    Sign in with Google to see the inviter's Codex accounts and
                    get a login command for their plans.
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
            <div className="space-y-3">
              {connectedNotice ? (
                <InlineMessage tone="default">{connectedNotice}</InlineMessage>
              ) : null}
              {inviteNotice ? (
                <InlineMessage tone="default">{inviteNotice}</InlineMessage>
              ) : null}
              {inviteAcceptError ? (
                <InlineMessage tone="error">{inviteAcceptError}</InlineMessage>
              ) : null}

              <div className="space-y-3">
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

                {guideVisible ? (
                  <GettingStartedPanel
                    onAddMachine={() => void handleStartPairing()}
                    onDismiss={() => {
                      setShowGuide(false)
                      setGuideHidden(true)
                    }}
                    onInviteViewer={() => void handleCreateInvite()}
                  />
                ) : null}

                {pairingError || inviteCreateError || pairingCommand || shareInvite ? (
                <Card size="sm">
                  <CardContent className="space-y-2">
                    {pairingError ? <InlineMessage tone="error">{pairingError}</InlineMessage> : null}
                    {inviteCreateError ? (
                      <InlineMessage tone="error">{inviteCreateError}</InlineMessage>
                    ) : null}
                    {pairingCommand ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          This adds that machine's own usage to your dashboard. To let
                          someone use your plans, use Share Codex login below.
                        </p>
                        <CommandRow
                          copied={isPairingCommandCopied}
                          error={pairingCopyError}
                          label="1. Run this once, in Terminal, on the machine where you use Codex"
                          meta={`Expires ${formatTimestamp(pairingCommand.expiresAt)}`}
                          onCopy={() => void handleCopyCommand()}
                          value={pairingCommand.command}
                        />
                        <CommandRow
                          copied={isSyncCommandCopied}
                          error={syncCommandCopyError}
                          label="2. Optional: keep this running there for live updates"
                          onCopy={() => void handleCopySyncCommand()}
                          value={pairingCommand.syncCommand}
                        />
                      </>
                    ) : null}
                    {shareInvite ? (
                      <CommandRow
                        copied={isInviteLinkCopied}
                        error={inviteCopyError}
                        label="Send this view-only link. They sign in with Google and see your plans."
                        meta={`Expires ${formatTimestamp(shareInvite.expiresAt)}`}
                        onCopy={() => void handleCopyInviteLink()}
                        value={shareInvite.inviteUrl}
                      />
                    ) : null}
                  </CardContent>
                </Card>
                ) : null}

                <Card className="min-w-0" size="sm">
                  <CardHeader
                    className={hasAccountsDetails ? 'border-b border-border' : undefined}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle>Plans</CardTitle>
                        <CardDescription>
                          {summary.accountsTracked}{' '}
                          {summary.accountsTracked === 1 ? 'account' : 'accounts'} · synced{' '}
                          {summary.mostRecentSync
                            ? formatRelativeTimestamp(summary.mostRecentSync)
                            : 'never'}
                          {summary.staleAccounts > 0
                            ? ` · ${summary.staleAccounts} stale`
                            : ''}
                        </CardDescription>
                        <RepairSignInsBanner devices={repairState.data} session={session} />
                      </div>
                      <Button
                        className="shrink-0"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void accountsQuery.refetch()
                          void weeklyUsageHistoryQuery.refetch()
                        }}
                      >
                        <RefreshCcw className="mr-1.5 size-3.5" />
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
                      {usageOverrideError ? (
                        <div className="px-4 pt-4 sm:px-5">
                          <InlineMessage tone="error">
                            {usageOverrideError}
                          </InlineMessage>
                        </div>
                      ) : null}
                      {isLoadingAccounts ? <LoadingRows /> : null}
                      {!isLoadingAccounts && accounts.length === 0 ? (
                        <EmptyState />
                      ) : null}
                      {accounts.length > 0 ? (
                        <>
                          <WeeklyUsageHistoryPanel
                            accounts={accounts}
                            accountsTracked={summary.accountsTracked}
                            errorMessage={
                              weeklyUsageHistoryQuery.error?.message ?? null
                            }
                            isLoading={weeklyUsageHistoryQuery.isPending}
                            onRangeChange={setWeeklyUsageRange}
                            points={weeklyUsageHistory}
                            range={weeklyUsageRange}
                          />
                          <ResetPlanPanel accounts={accounts} />
                          <div className="md:hidden">
                            <AccountSummaryList
                              accounts={accounts}
                              expiredEmails={expiredEmails}
                              notes={accountNotes}
                              onSaveUsageOverride={handleSaveUsageOverride}
                              primaryInviter={primaryInviter}
                              onUnlinkAccount={(account) =>
                                void handleUnlinkAccount(account)
                              }
                              unlinkingAccountId={unlinkingAccountId}
                              savingUsageOverride={savingUsageOverride}
                            />
                          </div>
                          <div className="hidden md:block">
                            <AccountTable
                              accounts={accounts}
                              expiredEmails={expiredEmails}
                              notes={accountNotes}
                              onSaveUsageOverride={handleSaveUsageOverride}
                              primaryInviter={primaryInviter}
                              onUnlinkAccount={(account) =>
                                void handleUnlinkAccount(account)
                              }
                              unlinkingAccountId={unlinkingAccountId}
                              savingUsageOverride={savingUsageOverride}
                            />
                          </div>
                        </>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>

                <SwitchHistoryPanel session={session} />

                <div id="share-codex-login">
                  <SharedLoginPanel
                    accounts={accounts}
                    onInvalidSession={handleInvalidSession}
                    session={session}
                  />
                </div>

              </div>
            </div>
          ) : (
            <TerminalConnectView
              authRedirectError={authIsLoading ? null : authRedirectError}
              connectCommand={connectCommand}
              isTerminalCommandCopied={isTerminalCommandCopied}
              loginError={authIsLoading ? null : loginError}
              onCopyCommand={() => void handleCopyTerminalCommand()}
              statusMessage={authIsLoading ? 'Checking sign-in...' : null}
              terminalCopyError={terminalCopyError}
            />
          )}
        </div>
      </div>
    </main>
  )
}

function TerminalConnectView({
  authRedirectError,
  connectCommand,
  isTerminalCommandCopied,
  loginError,
  onCopyCommand,
  statusMessage,
  terminalCopyError,
}: {
  authRedirectError: string | null
  connectCommand: string
  isTerminalCommandCopied: boolean
  loginError: string | null
  onCopyCommand: () => void
  statusMessage: string | null
  terminalCopyError: string | null
}) {
  return (
    <div
      aria-busy={statusMessage ? true : undefined}
      className="mx-auto max-w-[720px] space-y-4"
    >
      {loginError ? <InlineMessage tone="error">{loginError}</InlineMessage> : null}

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-[-0.02em]">Start here</h2>
        <p className="text-sm text-muted-foreground">
          Codex usage shows how much of every Codex plan is left, plans which account to use
          next, and switches machines to the next plan automatically.
        </p>
        <p className="text-sm text-foreground">
          Run this in Terminal on the machine where you use Codex. It links that machine and
          opens your dashboard:
        </p>

        {statusMessage ? (
          <p aria-live="polite" className="text-sm text-muted-foreground" role="status">
            {statusMessage}
          </p>
        ) : null}

        {authRedirectError ? (
          <InlineMessage tone="error">{authRedirectError}</InlineMessage>
        ) : null}

        <div className="relative rounded-lg border border-border bg-muted px-3 py-3 pr-12 font-mono text-xs leading-6 text-foreground">
          <Button
            aria-label={isTerminalCommandCopied ? 'Command copied' : 'Copy command'}
            className="absolute top-2 right-2"
            onClick={onCopyCommand}
            size="icon-sm"
            title={isTerminalCommandCopied ? 'Command copied' : 'Copy command'}
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

        <p className="text-sm text-muted-foreground">
          Got something from a friend? An invite link: sign in with Google at the top right to
          see their dashboard. A login command (it starts with <code>npx</code> and contains{' '}
          <code>use</code>): run it in Terminal and keep the window open. No sign-in needed.
        </p>

        {terminalCopyError ? (
          <InlineMessage tone="error">{terminalCopyError}</InlineMessage>
        ) : null}
      </section>
    </div>
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

function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <InlineMessage tone="default">{label}</InlineMessage>
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
    <p className="px-1 py-2 text-sm text-muted-foreground">
      No machines yet. Choose Add a machine, then run the command in Terminal on the
      computer where you use Codex. Its plans show up here within a minute.
    </p>
  )
}

function WeeklyUsageHistoryPanel({
  accounts,
  accountsTracked,
  errorMessage,
  isLoading,
  onRangeChange,
  points,
  range,
}: {
  accounts: DashboardAccountRow[]
  accountsTracked: number
  errorMessage: string | null
  isLoading: boolean
  onRangeChange: (range: DashboardWeeklyUsageRange) => void
  points: DashboardWeeklyUsageHistoryPoint[]
  range: DashboardWeeklyUsageRange
}) {
  const latestPoint = points[points.length - 1] ?? null
  // #33: the run-out at the recent spend pace, and the next weekly reset that would add allowance back.
  const projection = latestPoint ? projectRunOut(points) : null
  const nextReset = nextWeeklyReset(accounts, Date.now())
  const projectionText = projection
    ? projection.runsOutAt
      ? ` · at this pace (${projection.percentPerHour}%/h) it runs out ${formatResetCountdown(projection.runsOutAt)}, ${formatHistoryTooltipTimestamp(projection.runsOutAt)}${
          nextReset
            ? Date.parse(nextReset.at) < Date.parse(projection.runsOutAt)
              ? `; ${nextReset.label} resets ${formatResetCountdown(nextReset.at)} before that`
              : `; next reset ${formatResetCountdown(nextReset.at)} (${nextReset.label})`
            : ''
        }`
      : ' · no spend in the last 24h'
    : ''
  const capacityPercent = Math.max(
    accountsTracked * 100,
    latestPoint?.totalCapacityPercent ?? 0,
  )
  const rangeLabel =
    dashboardWeeklyUsageRanges.find((option) => option.value === range)?.label ??
    '7 day'
  const summaryText = latestPoint
    ? `${latestPoint.totalRemainingPercent}% left of ${capacityPercent}% - Updated ${formatRelativeTimestamp(latestPoint.fetchedAt)}${projectionText}`
    : isLoading
      ? 'Loading sync history...'
      : `No sync history in the last ${rangeLabel}.`

  return (
    <section className="border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <p className="font-medium text-foreground">Weekly remaining</p>
          <p className="text-muted-foreground">{summaryText}</p>
        </div>
        <div
          aria-label="History range"
          className="inline-flex rounded-lg border border-border bg-background p-0.5"
          role="group"
        >
          {dashboardWeeklyUsageRanges.map((option) => {
            const isSelected = option.value === range

            return (
              <button
                aria-pressed={isSelected}
                className={`h-6 rounded-md px-2 text-xs font-medium transition-colors ${
                  isSelected
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                key={option.value}
                onClick={() => onRangeChange(option.value)}
                type="button"
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      {errorMessage ? (
        <InlineMessage className="mt-2" tone="error">
          {errorMessage}
        </InlineMessage>
      ) : isLoading && points.length === 0 ? (
        <div className="mt-2 h-28 animate-pulse rounded-md bg-muted" />
      ) : points.length === 0 ? (
        <div className="mt-2 flex h-28 items-center justify-center rounded-md border border-border bg-muted/40 px-4 text-sm text-muted-foreground">
          No points to plot.
        </div>
      ) : (
        <WeeklyUsageHistoryChart
          capacityPercent={capacityPercent}
          points={points}
          projection={projection}
          range={range}
        />
      )}
    </section>
  )
}

function WeeklyUsageHistoryChart({
  capacityPercent,
  points,
  projection,
  range,
}: {
  capacityPercent: number
  points: DashboardWeeklyUsageHistoryPoint[]
  projection: UsageProjection | null
  range: DashboardWeeklyUsageRange
}) {
  const chart = buildWeeklyUsageChart(points, range, capacityPercent, projection)
  // #35: the pointer's x in viewBox units names the nearest point, or the projection past the newest one.
  const [hoverX, setHoverX] = useState<number | null>(null)
  const reading =
    hoverX == null
      ? null
      : readingAtX(hoverX, {
          coordinates: chart.coordinates,
          domain: chart.domain,
          projection,
          projectionEndMs: chart.projectionEndMs,
        })
  const pause =
    reading?.kind === 'history'
      ? stretchAt(chart.inactivity, Date.parse(reading.at))
      : null
  const readPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    setHoverX(((event.clientX - rect.left) / rect.width) * 1000)
  }

  return (
    <div className="relative mt-2 overflow-hidden rounded-md border border-border bg-background">
      <svg
        aria-label="Weekly total remaining history"
        className="h-auto w-full"
        onPointerDown={readPointer}
        onPointerLeave={() => setHoverX(null)}
        onPointerMove={readPointer}
        role="img"
        viewBox="0 0 1000 112"
      >
        <title>Weekly total remaining history</title>
        {chart.yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              stroke="var(--border)"
              strokeWidth="1"
              x1={chart.bounds.left}
              x2={chart.bounds.right}
              y1={tick.y}
              y2={tick.y}
            />
            <text
              fill="var(--muted-foreground)"
              fontSize="10"
              textAnchor="end"
              x={chart.bounds.left - 8}
              y={tick.y + 4}
            >
              {tick.value}%
            </text>
          </g>
        ))}
        <line
          stroke="var(--border)"
          strokeWidth="1"
          x1={chart.bounds.left}
          x2={chart.bounds.left}
          y1={chart.bounds.top}
          y2={chart.bounds.bottom}
        />
        <line
          stroke="var(--border)"
          strokeWidth="1"
          x1={chart.bounds.left}
          x2={chart.bounds.right}
          y1={chart.bounds.bottom}
          y2={chart.bounds.bottom}
        />
        {chart.inactivity.map((stretch) => (
          <rect
            fill="var(--muted-foreground)"
            height={chart.bounds.bottom - chart.bounds.top}
            key={stretch.fromAt}
            opacity="0.1"
            width={stretch.width}
            x={stretch.x}
            y={chart.bounds.top}
          >
            <title>
              No spend from {formatHistoryTooltipTimestamp(stretch.fromAt)} to{' '}
              {formatHistoryTooltipTimestamp(stretch.toAt)} (
              {formatSpanShort(stretch.durationMs)})
            </title>
          </rect>
        ))}
        {chart.inactivity.length > 0 ? (
          <text
            fill="var(--muted-foreground)"
            fontSize="9"
            textAnchor="end"
            x={chart.bounds.right}
            y={chart.bounds.top - 2}
          >
            shaded: no spend
          </text>
        ) : null}
        {chart.areaPath ? (
          <path d={chart.areaPath} fill="var(--chart-1)" opacity="0.12" />
        ) : null}
        <path
          d={chart.linePath}
          fill="none"
          stroke="var(--chart-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        {chart.nowX != null ? (
          <line
            stroke="var(--border)"
            strokeDasharray="2 4"
            strokeWidth="1"
            x1={chart.nowX}
            x2={chart.nowX}
            y1={chart.bounds.top}
            y2={chart.bounds.bottom}
          />
        ) : null}
        {chart.projectionPath ? (
          <path
            d={chart.projectionPath}
            fill="none"
            opacity="0.75"
            stroke="var(--chart-1)"
            strokeDasharray="5 5"
            strokeLinecap="round"
            strokeWidth="2"
          />
        ) : null}
        {chart.runOutDot ? (
          <circle
            cx={chart.runOutDot.x}
            cy={chart.runOutDot.y}
            fill="var(--background)"
            r="3.5"
            stroke="var(--chart-1)"
            strokeDasharray="2 2"
            strokeWidth="2"
          >
            <title>Runs out at {chart.runOutDot.label} at the current pace</title>
          </circle>
        ) : null}
        {chart.pointsForDots.map((point) => (
          <circle
            cx={point.x}
            cy={point.y}
            fill="var(--background)"
            key={`${point.fetchedAt}-${point.x}`}
            r="3"
            stroke="var(--chart-1)"
            strokeWidth="2"
          >
            <title>
              {point.totalRemainingPercent}% at{' '}
              {formatHistoryTooltipTimestamp(point.fetchedAt)}
            </title>
          </circle>
        ))}
        {reading ? (
          <g>
            <line
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
              strokeWidth="1"
              x1={reading.x}
              x2={reading.x}
              y1={chart.bounds.top}
              y2={chart.bounds.bottom}
            />
            <circle
              cx={reading.x}
              cy={reading.y}
              fill="var(--chart-1)"
              r="4"
              stroke="var(--background)"
              strokeWidth="2"
            />
          </g>
        ) : null}
        {chart.xTicks.map((tick) => (
          <text
            fill="var(--muted-foreground)"
            fontSize="10"
            key={tick.label}
            textAnchor={tick.anchor}
            x={tick.x}
            y={chart.bounds.bottom + 16}
          >
            {tick.label}
          </text>
        ))}
      </svg>
      {reading ? (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-xs shadow-md"
          style={{
            left: `${(reading.x / 1000) * 100}%`,
            top: `${(reading.y / 112) * 100}%`,
            transform: `translate(${reading.x > 720 ? 'calc(-100% - 8px)' : '8px'}, ${reading.y < 45 ? '12px' : '-110%'})`,
          }}
        >
          <p className="font-medium text-foreground">
            {reading.kind === 'projection'
              ? `~${reading.remainingPercent}% left (projected)`
              : `${reading.remainingPercent}% left of ${capacityPercent}%`}
          </p>
          <p className="text-muted-foreground">
            {formatHistoryTooltipTimestamp(reading.at)}
          </p>
          {pause ? (
            <p className="text-muted-foreground">
              no spend for{' '}
              {formatSpanShort(Date.parse(reading.at) - Date.parse(pause.fromAt))}
            </p>
          ) : null}
        </div>
      ) : null}
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

/** Usage-limit reset credits the account owns, from the latest snapshot; a dot when the sync never carried them. */
function formatResetCredits(account: DashboardAccountRow) {
  const raw = account.raw_rate_limits as { resetCredits?: { available?: unknown } } | null
  const available = raw?.resetCredits?.available
  return typeof available === 'number' ? String(available) : '·'
}

function AccountTable({
  accounts,
  expiredEmails,
  notes,
  onSaveUsageOverride,
  primaryInviter,
  onUnlinkAccount,
  savingUsageOverride,
  unlinkingAccountId,
}: {
  accounts: DashboardAccountRow[]
  expiredEmails: Set<string>
  notes: AccountNotesController | null
  onSaveUsageOverride: (
    account: DashboardAccountRow,
    windowKey: RateLimitWindowKey,
    remainingPercent: number,
  ) => Promise<boolean>
  primaryInviter: DashboardInviterRow | null
  onUnlinkAccount: (account: DashboardAccountRow) => void
  savingUsageOverride: string | null
  unlinkingAccountId: string | null
}) {
  const columnCount = notes ? 9 : 6
  const accountEmails = new Set(accounts.map((account) => noteKey(account.email)).filter(Boolean))
  const noteOnly = notes ? notes.notes.filter((note) => !accountEmails.has(noteKey(note.email))) : []
  const emailSuggestions = notes
    ? accounts
        .filter((account) => account.access_scope === 'owned' && account.email && !notes.byEmail.has(noteKey(account.email)))
        .map((account) => noteKey(account.email))
    : []
  const editorRow = (key: string) =>
    notes ? (
      <TableRow key={key}>
        <TableCell className="px-4 py-2" colSpan={columnCount}>
          <NoteEditor controller={notes} emailSuggestions={emailSuggestions} />
        </TableCell>
      </TableRow>
    ) : null

  return (
    <Table className={notes ? 'min-w-[1120px]' : 'min-w-[800px]'}>
      <TableHeader className="bg-muted/50">
        <TableRow className="hover:bg-muted/50">
          <TableHead className="h-8 w-8 px-3 text-right text-xs">#</TableHead>
          <TableHead className="h-8 px-4 text-xs">Account</TableHead>
          <TableHead className="h-8 text-xs">Synced</TableHead>
          <TableHead className="h-8 text-xs">Usable</TableHead>
          <TableHead className="h-8 text-xs" title="Usage-limit reset credits the account owns">Resets</TableHead>
          {notes ? (
            <>
              <TableHead className="h-8 text-xs" title="The ChatGPT or Claude password for this login">Password</TableHead>
              <TableHead className="h-8 text-xs">Google</TableHead>
              <TableHead className="h-8 text-xs">Note</TableHead>
            </>
          ) : null}
          <TableHead className="h-8 w-16 px-4 text-right">
            {notes ? (
              <Button
                aria-label="Add a note for another email"
                className="size-6"
                disabled={notes.busy || notes.adding}
                onClick={() => notes.startAdd(emailSuggestions[0] ?? '')}
                size="icon"
                title="Add a note for another email"
                type="button"
                variant="ghost"
              >
                <Plus className="size-3.5" />
              </Button>
            ) : (
              <span className="sr-only">Unlink</span>
            )}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {notes?.error ? (
          <TableRow>
            <TableCell className="px-4 py-2 text-destructive text-sm" colSpan={columnCount}>
              {notes.error}
            </TableCell>
          </TableRow>
        ) : null}
        {accounts.map((account, index) => {
          const identity = getAccountIdentityLines(account)
          const limitWindows = getRateLimitWindows(account)
          const isOwnedAccount = account.access_scope === 'owned'
          const isUnlinking = unlinkingAccountId === account.id
          const note = notes && isOwnedAccount ? notes.byEmail.get(noteKey(account.email)) : undefined
          if (notes && isOwnedAccount && account.email && notes.isEditing(account.email)) {
            return editorRow(account.id)
          }

          return (
            <TableRow key={account.id}>
              <TableCell className="px-3 py-1.5 text-right text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </TableCell>
              <TableCell className="px-4 py-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <p
                    className="truncate font-medium text-foreground"
                    title={[identity.secondary, formatPlanLine(account)].filter(Boolean).join(' · ')}
                  >
                    {identity.primary}
                  </p>
                  {isClaudeAccount(account) ? <ClaudeBadge /> : null}
                  {account.plan_type ? (
                    <span className="rounded border border-border px-1 text-[10px] uppercase leading-4 text-muted-foreground">
                      {account.plan_type}
                    </span>
                  ) : null}
                  {expiredEmails.has(noteKey(account.email)) ? (
                    <span className="rounded border border-amber-500/40 px-1 text-[10px] leading-4 text-amber-600 dark:text-amber-400" title="This machine's saved sign-in for this account is refused; use Fix sign-ins">
                      sign-in expired
                    </span>
                  ) : null}
                  {!isOwnedAccount ? (
                    <SharedAccessNote inviter={primaryInviter} />
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="py-1.5">
                <p
                  className="text-sm text-foreground"
                  title={formatTimestamp(account.last_snapshot_at)}
                >
                  {formatRelativeTimestamp(account.last_snapshot_at)}
                </p>
              </TableCell>
              <TableCell className="py-1.5">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {limitWindows.length > 0 ? (
                    limitWindows.map((window) => (
                      <div className="flex items-center gap-2" key={window.key}>
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${
                            window.remainingPercent == null
                              ? 'bg-muted-foreground/40'
                              : window.remainingPercent <= 0
                                ? 'bg-red-500'
                                : window.remainingPercent <= 20
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                          }`}
                        />
                        <p className="w-12 text-xs text-muted-foreground">
                          {window.label}
                        </p>
                        <RemainingPercentageEditor
                          canEdit={isOwnedAccount}
                          isOverridden={
                            window.key === 'primary'
                              ? account.primary_remaining_overridden
                              : account.secondary_remaining_overridden
                          }
                          isSaving={
                            savingUsageOverride ===
                            `${account.id}:${window.key}`
                          }
                          onSave={(value) =>
                            onSaveUsageOverride(account, window.key, value)
                          }
                          value={window.remainingPercent}
                          windowLabel={window.label}
                        />
                        <p
                          className="text-xs text-muted-foreground"
                          title={formatTimestamp(window.resetsAt)}
                        >
                          resets {formatResetCountdown(window.resetsAt)}
                        </p>
                      </div>
                    ))
                  ) : (
                    <span className="text-muted-foreground">N/A</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="py-1.5 text-xs tabular-nums">
                {formatResetCredits(account)}
              </TableCell>
              {notes ? (
                <>
                  <TableCell className="py-1.5">
                    {isOwnedAccount ? <NoteSecret controller={notes} field="chatgptPassword" note={note} /> : null}
                  </TableCell>
                  <TableCell className="py-1.5">
                    {isOwnedAccount ? <NoteSecret controller={notes} field="googlePassword" note={note} /> : null}
                  </TableCell>
                  <TableCell className="max-w-[16rem] py-1.5">
                    {isOwnedAccount ? (
                      <p className="truncate text-xs" title={note?.note ?? ''}>
                        {note?.note ?? <span className="text-muted-foreground">·</span>}
                      </p>
                    ) : null}
                  </TableCell>
                </>
              ) : null}
              <TableCell className="px-4 py-1.5 text-right">
                {isOwnedAccount ? (
                  <span className="inline-flex items-center gap-0.5">
                    {notes && account.email ? (
                      <Button
                        aria-label={`Edit passwords and note for ${account.email}`}
                        className="size-6"
                        disabled={notes.busy}
                        onClick={() => notes.startEdit(account.email as string)}
                        size="icon"
                        title={note ? 'Edit passwords and note' : 'Add passwords and note'}
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    ) : null}
                    <UnlinkAccountButton
                      disabled={Boolean(unlinkingAccountId)}
                      isUnlinking={isUnlinking}
                      onClick={() => onUnlinkAccount(account)}
                    />
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
        {notes
          ? noteOnly.map((note) =>
              notes.isEditing(note.email) ? (
                editorRow(`note:${note.email}`)
              ) : (
                <TableRow key={`note:${note.email}`}>
                  <TableCell className="px-3 py-1.5" />
                  <TableCell className="px-4 py-1.5">
                    <p className="truncate font-mono text-xs" title={note.email}>
                      {note.email}
                    </p>
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground">note only</TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground">·</TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground">·</TableCell>
                  <TableCell className="py-1.5"><NoteSecret controller={notes} field="chatgptPassword" note={note} /></TableCell>
                  <TableCell className="py-1.5"><NoteSecret controller={notes} field="googlePassword" note={note} /></TableCell>
                  <TableCell className="max-w-[16rem] py-1.5">
                    <p className="truncate text-xs" title={note.note ?? ''}>
                      {note.note ?? <span className="text-muted-foreground">·</span>}
                    </p>
                  </TableCell>
                  <TableCell className="px-4 py-1.5 text-right">
                    <span className="inline-flex items-center gap-0.5">
                      <Button aria-label={`Edit ${note.email}`} className="size-6" disabled={notes.busy} onClick={() => notes.startEdit(note.email)} size="icon" type="button" variant="ghost">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button aria-label={`Remove ${note.email}`} className="size-6" disabled={notes.busy} onClick={() => void notes.remove(note.email)} size="icon" type="button" variant="ghost">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ),
            )
          : null}
        {notes?.adding ? editorRow('note:new') : null}
      </TableBody>
    </Table>
  )
}

function AccountSummaryList({
  accounts,
  expiredEmails,
  notes,
  onSaveUsageOverride,
  primaryInviter,
  onUnlinkAccount,
  savingUsageOverride,
  unlinkingAccountId,
}: {
  accounts: DashboardAccountRow[]
  expiredEmails: Set<string>
  notes: AccountNotesController | null
  onSaveUsageOverride: (
    account: DashboardAccountRow,
    windowKey: RateLimitWindowKey,
    remainingPercent: number,
  ) => Promise<boolean>
  primaryInviter: DashboardInviterRow | null
  onUnlinkAccount: (account: DashboardAccountRow) => void
  savingUsageOverride: string | null
  unlinkingAccountId: string | null
}) {
  return (
    <div className="divide-y divide-border">
      {accounts.map((account) => {
        const identity = getAccountIdentityLines(account)
        const limitWindows = getRateLimitWindows(account)
        const isOwnedAccount = account.access_scope === 'owned'
        const isUnlinking = unlinkingAccountId === account.id

        return (
          <div key={account.id} className="space-y-2 px-4 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 font-medium text-foreground">
                  <span>{identity.primary}</span>
                  {isClaudeAccount(account) ? <ClaudeBadge /> : null}
                </p>
                {identity.secondary ? (
                  <p className="truncate text-sm text-muted-foreground">
                    {identity.secondary}
                  </p>
                ) : null}
                {expiredEmails.has(noteKey(account.email)) ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">sign-in expired</p>
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
              <MetaField label="Resets" value={formatResetCredits(account)} />
              <MetaField
                label="Plan first seen"
                value={formatPlanObservedAt(account)}
              />
              {limitWindows.length > 0 ? (
                limitWindows.flatMap((window) => [
                  <MetaField
                    key={`${window.key}-remaining`}
                    label={`${window.label} remaining`}
                    value={
                      <RemainingPercentageEditor
                        canEdit={isOwnedAccount}
                        isOverridden={
                          window.key === 'primary'
                            ? account.primary_remaining_overridden
                            : account.secondary_remaining_overridden
                        }
                        isSaving={
                          savingUsageOverride === `${account.id}:${window.key}`
                        }
                        onSave={(value) =>
                          onSaveUsageOverride(account, window.key, value)
                        }
                        value={window.remainingPercent}
                        windowLabel={window.label}
                      />
                    }
                  />,
                  <MetaField
                    key={`${window.key}-reset`}
                    label={`${window.label} reset`}
                    value={`${formatResetCountdown(window.resetsAt)} · ${formatTimestamp(window.resetsAt)}`.replace(/^in /, '')}
                  />,
                ])
              ) : (
                <MetaField label="Usage limits" value="N/A" />
              )}
              {notes && isOwnedAccount && account.email ? (
                notes.isEditing(account.email) ? (
                  <div className="col-span-2">
                    <NoteEditor controller={notes} />
                  </div>
                ) : (
                  <>
                    <MetaField label="ChatGPT" value={<NoteSecret controller={notes} field="chatgptPassword" note={notes.byEmail.get(noteKey(account.email))} />} />
                    <MetaField label="Google" value={<NoteSecret controller={notes} field="googlePassword" note={notes.byEmail.get(noteKey(account.email))} />} />
                    <MetaField
                      label="Note"
                      value={
                        <span className="inline-flex items-center gap-1">
                          <span className="truncate">{notes.byEmail.get(noteKey(account.email))?.note ?? '·'}</span>
                          <Button aria-label={`Edit passwords and note for ${account.email}`} className="size-6" disabled={notes.busy} onClick={() => notes.startEdit(account.email as string)} size="icon" type="button" variant="ghost">
                            <Pencil className="size-3.5" />
                          </Button>
                        </span>
                      }
                    />
                  </>
                )
              ) : null}
            </dl>
          </div>
        )
      })}
      {notes
        ? notes.notes
            .filter((note) => !accounts.some((account) => noteKey(account.email) === noteKey(note.email)))
            .map((note) => (
              <div className="space-y-2 px-4 py-2.5" key={`note:${note.email}`}>
                {notes.isEditing(note.email) ? (
                  <NoteEditor controller={notes} />
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <p className="truncate font-mono text-xs" title={note.email}>{note.email}</p>
                      <span className="inline-flex items-center gap-0.5">
                        <Button aria-label={`Edit ${note.email}`} className="size-6" disabled={notes.busy} onClick={() => notes.startEdit(note.email)} size="icon" type="button" variant="ghost"><Pencil className="size-3.5" /></Button>
                        <Button aria-label={`Remove ${note.email}`} className="size-6" disabled={notes.busy} onClick={() => void notes.remove(note.email)} size="icon" type="button" variant="ghost"><Trash2 className="size-3.5" /></Button>
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <MetaField label="ChatGPT" value={<NoteSecret controller={notes} field="chatgptPassword" note={note} />} />
                      <MetaField label="Google" value={<NoteSecret controller={notes} field="googlePassword" note={note} />} />
                      <MetaField label="Note" value={note.note ?? '·'} />
                    </dl>
                  </>
                )}
              </div>
            ))
        : null}
      {notes ? (
        <div className="px-4 py-2.5">
          {notes.adding ? (
            <NoteEditor controller={notes} />
          ) : (
            <Button disabled={notes.busy} onClick={() => notes.startAdd()} size="sm" type="button" variant="outline">
              <Plus className="size-3.5" /> Add a note for another email
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ClaudeBadge() {
  return (
    <span
      className="rounded border border-orange-500/40 px-1 text-[10px] uppercase leading-4 text-orange-700 dark:text-orange-300"
      title="A Claude login reported by sync --all"
    >
      Claude
    </span>
  )
}

function formatPlanLine(account: DashboardAccountRow) {
  const plan = account.plan_type ?? 'Unknown plan'
  return account.plan_started_at
    ? `${plan} since ${formatTimestamp(account.plan_started_at)}`
    : plan
}

function formatPlanObservedAt(account: DashboardAccountRow) {
  if (!account.plan_started_at) {
    return 'Not observed yet'
  }

  return `First seen ${formatTimestamp(account.plan_started_at)}`
}

function CommandRow({
  copied,
  error,
  label,
  meta,
  onCopy,
  value,
}: {
  copied: boolean
  error: string | null
  label: string
  meta?: string
  onCopy: () => void
  value: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      <div className="relative rounded-md border border-border bg-muted px-2.5 py-2 pr-10 font-mono text-xs leading-5 break-all text-foreground">
        <Button
          aria-label={copied ? 'Copied' : 'Copy'}
          className="absolute top-1 right-1 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={onCopy}
          size="icon-sm"
          title={copied ? 'Copied' : 'Copy'}
          type="button"
          variant="ghost"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
        {value}
      </div>
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
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
  value: ReactNode
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

interface WeeklyUsageChartBounds {
  bottom: number
  left: number
  right: number
  top: number
}

interface WeeklyUsageChartPoint {
  fetchedAt: string
  totalRemainingPercent: number
  x: number
  y: number
}

function buildWeeklyUsageChart(
  points: DashboardWeeklyUsageHistoryPoint[],
  range: DashboardWeeklyUsageRange,
  capacityPercent: number,
  projection: UsageProjection | null = null,
) {
  const bounds: WeeklyUsageChartBounds = {
    bottom: 88,
    left: 48,
    right: 988,
    top: 10,
  }
  const rangeMs =
    getDashboardWeeklyUsageRangeDays(range) * 24 * 60 * 60 * 1000
  const endMs = Date.now()
  const startMs = endMs - rangeMs
  // #33: the run-out sits past now; the axis follows it up to half a range ahead.
  const runsOutAtMs = projection?.runsOutAt ? Date.parse(projection.runsOutAt) : null
  const horizonMs =
    runsOutAtMs != null && Number.isFinite(runsOutAtMs)
      ? Math.min(Math.max(runsOutAtMs - endMs, 0), rangeMs / 2)
      : 0
  const domainEndMs = endMs + horizonMs
  const domainMs = domainEndMs - startMs
  const plotWidth = bounds.right - bounds.left
  const plotHeight = bounds.bottom - bounds.top
  const parsedPoints = points
    .map((point) => ({
      ...point,
      fetchedAtMs: Date.parse(point.fetchedAt),
    }))
    .filter((point) => Number.isFinite(point.fetchedAtMs))
    .sort((left, right) => left.fetchedAtMs - right.fetchedAtMs)
  const maxPointValue = parsedPoints.reduce(
    (maxValue, point) =>
      Math.max(maxValue, point.totalRemainingPercent, point.totalCapacityPercent),
    capacityPercent,
  )
  const yMax = Math.max(100, Math.ceil(maxPointValue / 100) * 100)
  const coordinates: WeeklyUsageChartPoint[] = parsedPoints.map((point) => {
    const clampedTime = Math.min(Math.max(point.fetchedAtMs, startMs), domainEndMs)
    const x = bounds.left + ((clampedTime - startMs) / domainMs) * plotWidth
    const y =
      bounds.bottom -
      (Math.min(Math.max(point.totalRemainingPercent, 0), yMax) / yMax) *
        plotHeight

    return {
      fetchedAt: point.fetchedAt,
      totalRemainingPercent: point.totalRemainingPercent,
      x: roundChartCoordinate(x),
      y: roundChartCoordinate(y),
    }
  })
  const linePath = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ')
  const areaPath =
    coordinates.length > 0
      ? `${linePath} L ${coordinates[coordinates.length - 1].x} ${bounds.bottom} L ${coordinates[0].x} ${bounds.bottom} Z`
      : null
  const middleTick = Math.round(yMax / 2)
  const timeToX = (time: number) =>
    roundChartCoordinate(
      bounds.left +
        ((Math.min(Math.max(time, startMs), domainEndMs) - startMs) / domainMs) *
          plotWidth,
    )
  const valueToY = (value: number) =>
    roundChartCoordinate(
      bounds.bottom - (Math.min(Math.max(value, 0), yMax) / yMax) * plotHeight,
    )
  const latestCoordinate = coordinates[coordinates.length - 1] ?? null
  const projectionEndMs =
    runsOutAtMs != null && horizonMs > 0 ? Math.min(runsOutAtMs, domainEndMs) : null
  const projectionPath =
    projection && latestCoordinate && projectionEndMs != null
      ? `M ${latestCoordinate.x} ${latestCoordinate.y} L ${timeToX(projectionEndMs)} ${valueToY(projectedRemainingAt(projection, projectionEndMs))}`
      : null
  const runOutDot =
    projection && runsOutAtMs != null && projectionPath && runsOutAtMs <= domainEndMs
      ? {
          label: formatHistoryTooltipTimestamp(projection.runsOutAt ?? ''),
          x: timeToX(runsOutAtMs),
          y: valueToY(0),
        }
      : null
  // #36: stretches of no spend, shaded behind the line.
  const inactivity = inactivityStretches(parsedPoints).map((stretch) => {
    const x = timeToX(Date.parse(stretch.fromAt))
    return {
      ...stretch,
      width: Math.max(1, timeToX(Date.parse(stretch.toAt)) - x),
      x,
    }
  })
  const domain: ChartHoverDomain = {
    bottom: bounds.bottom,
    domainEndMs,
    left: bounds.left,
    right: bounds.right,
    startMs,
    top: bounds.top,
    yMax,
  }
  const xTickValues =
    horizonMs > 0
      ? [
          { anchor: 'start' as const, time: startMs },
          { anchor: 'middle' as const, time: endMs },
          { anchor: 'end' as const, time: domainEndMs },
        ]
      : [
          { anchor: 'start' as const, time: startMs },
          { anchor: 'middle' as const, time: startMs + rangeMs / 2 },
          { anchor: 'end' as const, time: endMs },
        ]

  return {
    areaPath,
    bounds,
    linePath,
    coordinates,
    domain,
    inactivity,
    nowX: horizonMs > 0 ? timeToX(endMs) : null,
    pointsForDots: coordinates.length <= 80 ? coordinates : [],
    projectionEndMs,
    projectionPath,
    runOutDot,
    xTicks: xTickValues.map((tick) => ({
      anchor: tick.anchor,
      label: formatHistoryAxisTimestamp(tick.time, range),
      x:
        tick.anchor === 'start'
          ? bounds.left
          : tick.anchor === 'end'
            ? bounds.right
            : timeToX(tick.time),
    })),
    yTicks: [yMax, middleTick, 0].map((value) => ({
      value,
      y: roundChartCoordinate(bounds.bottom - (value / yMax) * plotHeight),
    })),
  }
}

function roundChartCoordinate(value: number) {
  return Math.round(value * 100) / 100
}

function formatHistoryAxisTimestamp(
  value: number,
  range: DashboardWeeklyUsageRange,
) {
  const formatter =
    range === '1d'
      ? new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
        })
      : new Intl.DateTimeFormat('en-US', {
          day: 'numeric',
          month: 'short',
        })

  return formatter.format(new Date(value))
}

function formatHistoryTooltipTimestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time'
  }

  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(parsed)
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

  if (days > 0) {
    return `in ${days}d ${hours}h`
  }

  if (hours > 0) {
    return `in ${hours}h ${minutes}m`
  }

  return `in ${minutes}m`
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
