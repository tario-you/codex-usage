import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  Clock3,
  Database,
  FolderSymlink,
  Layers3,
  type LucideIcon,
  RefreshCcw,
  Server,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  buildSummary,
  dashboardAccountsQueryOptions,
  getModelBuckets,
  type DashboardAccountRow,
} from '@/lib/dashboard'
import {
  formatRelativeTimestamp,
  formatTimestamp,
  formatWindowLabel,
  isFreshTimestamp,
} from '@/shared/codex'

export function DashboardPage() {
  const accountsQuery = useQuery(dashboardAccountsQueryOptions)
  const accounts = accountsQuery.data ?? []
  const summary = buildSummary(accounts)

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,218,158,0.55),_transparent_25%),radial-gradient(circle_at_80%_10%,_rgba(17,24,39,0.08),_transparent_22%),linear-gradient(180deg,_#fffaf1_0%,_#efe8d8_100%)] text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
          <Card className="overflow-hidden border-white/60 bg-white/80 shadow-[0_24px_70px_-28px_rgba(17,24,39,0.45)] backdrop-blur">
            <CardHeader className="gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge className="rounded-full bg-slate-900 px-3 py-1 text-[11px] tracking-[0.16em] uppercase text-amber-50">
                  Codex usage deck
                </Badge>
                <Badge
                  variant="outline"
                  className="rounded-full border-slate-300 bg-white/70 px-3 py-1 text-xs text-slate-700"
                >
                  Supabase-backed snapshots
                </Badge>
              </div>
              <div className="max-w-3xl space-y-3">
                <CardTitle className="font-heading text-4xl leading-tight tracking-[-0.05em] sm:text-5xl">
                  One dashboard for every Codex account you care about.
                </CardTitle>
                <CardDescription className="max-w-2xl text-base leading-7 text-slate-600">
                  The collector writes the latest known usage snapshot for each
                  account into Supabase. When you switch accounts, older ones stay
                  visible with their last sync time instead of disappearing.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <SummaryStat
                icon={Layers3}
                label="Accounts tracked"
                value={String(summary.accountsTracked)}
                note="Every seen account stays on the board."
              />
              <SummaryStat
                icon={Server}
                label="Stale accounts"
                value={String(summary.staleAccounts)}
                note="Accounts not refreshed in the last 15 minutes."
              />
              <SummaryStat
                icon={AlertTriangle}
                label="Low remaining"
                value={String(summary.lowBalanceCount)}
                note="5-hour or weekly balance at or below 20%."
              />
              <SummaryStat
                icon={Clock3}
                label="Latest sync"
                value={formatRelativeTimestamp(summary.mostRecentSync)}
                note={
                  summary.mostRecentSync
                    ? formatTimestamp(summary.mostRecentSync)
                    : 'No snapshots stored yet.'
                }
              />
            </CardContent>
          </Card>

          <Card className="border-slate-900/10 bg-slate-950 text-slate-50 shadow-[0_24px_70px_-30px_rgba(15,23,42,0.6)]">
            <CardHeader>
              <Badge className="w-fit rounded-full bg-emerald-400/15 px-3 py-1 text-[11px] tracking-[0.16em] uppercase text-emerald-200">
                Automatic capture
              </Badge>
              <CardTitle className="font-heading text-2xl tracking-[-0.04em]">
                Three-account workflow
              </CardTitle>
              <CardDescription className="text-sm leading-6 text-slate-300">
                Use one watcher on your default `~/.codex` for passive discovery,
                then promote the important accounts into dedicated slots that keep
                polling in the background.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-200">
              <StepRow
                title="1. Watch your default home"
                body="The collector notices account changes and writes a fresh snapshot as soon as rate limits update."
              />
              <StepRow
                title="2. Keep prized accounts warm"
                body="Dedicated slots isolate separate CODEX_HOME directories, so all three accounts can refresh independently."
              />
              <StepRow
                title="3. Read from one dashboard"
                body="The UI only needs Supabase. It shows fresh rows when available and stale rows with last_updated when not."
              />
            </CardContent>
          </Card>
        </section>

        <Tabs defaultValue="accounts" className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList className="w-full rounded-full border border-slate-300/70 bg-white/80 sm:w-auto">
              <TabsTrigger value="accounts" className="rounded-full px-5">
                Accounts
              </TabsTrigger>
              <TabsTrigger value="setup" className="rounded-full px-5">
                Collector setup
              </TabsTrigger>
            </TabsList>
            <Button
              variant="outline"
              className="rounded-full bg-white/80"
              onClick={() => void accountsQuery.refetch()}
            >
              <RefreshCcw className="mr-2 size-4" />
              Refresh view
            </Button>
          </div>

          <TabsContent value="accounts" className="space-y-5">
            {accountsQuery.error ? (
              <Card className="border-rose-200 bg-rose-50/90 text-rose-900">
                <CardHeader>
                  <CardTitle className="font-heading text-xl">
                    Dashboard data is not ready yet
                  </CardTitle>
                  <CardDescription className="text-rose-800">
                    {accountsQuery.error.message}
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : null}

            {accountsQuery.isPending && accounts.length === 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <LoadingCard />
                <LoadingCard />
              </div>
            ) : null}

            {!accountsQuery.isPending && accounts.length === 0 ? (
              <Card className="border-dashed border-slate-300 bg-white/75">
                <CardHeader>
                  <CardTitle className="font-heading text-2xl">
                    No Codex snapshots yet
                  </CardTitle>
                  <CardDescription className="max-w-2xl text-base leading-7">
                    Start the collector once your Supabase URL and keys are set.
                    As soon as a source reports account usage, this page will fill
                    in automatically and keep older accounts visible.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : null}

            <div className="grid gap-5 lg:grid-cols-2">
              {accounts.map((account) => (
                <AccountCard key={account.id} account={account} />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="setup" className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <Card className="border-white/60 bg-white/80 shadow-[0_20px_50px_-30px_rgba(15,23,42,0.45)]">
              <CardHeader>
                <CardTitle className="font-heading text-2xl tracking-[-0.04em]">
                  Files to keep around
                </CardTitle>
                <CardDescription className="text-base leading-7 text-slate-600">
                  The repo already includes the pieces you need for an automatic
                  background sync. Copy the example source file, set your Supabase
                  keys, and run the collector continuously.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <SetupRow
                  file=".env.example"
                  detail="Copy this into .env.local for the app and .env.collector.local for the collector with your real keys."
                />
                <SetupRow
                  file="collector.sources.example.json"
                  detail="Copy to collector.sources.json and enable the three source slots you want to keep warm."
                />
                <SetupRow
                  file="scripts/codex-collector.ts"
                  detail="This script talks to Codex app-server, upserts the account row, and inserts immutable snapshots."
                />
                <SetupRow
                  file="supabase/migrations"
                  detail="The schema keeps the latest snapshot visible through the codex_dashboard_accounts view."
                />
              </CardContent>
            </Card>

            <Card className="border-slate-900/10 bg-slate-950 text-slate-50">
              <CardHeader>
                <CardTitle className="font-heading text-2xl tracking-[-0.04em]">
                  Suggested background loop
                </CardTitle>
                <CardDescription className="text-sm leading-6 text-slate-300">
                  On macOS, use a `launchd` agent that runs `npm run collector` in
                  this workspace. The collector itself keeps retrying if a Codex
                  source is not ready yet.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm leading-7 text-slate-200">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 font-mono text-xs text-emerald-200">
                  <p>cp collector.sources.example.json collector.sources.json</p>
                  <p>cp .env.example .env.collector.local</p>
                  <p>npm run collector</p>
                </div>
                <Separator className="bg-white/10" />
                <p>
                  If you only want passive discovery, enable the `default-home`
                  source. If you want all three accounts to keep updating without
                  manual switching, enable the dedicated slots too.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}

function SummaryStat({
  icon: Icon,
  label,
  note,
  value,
}: {
  icon: LucideIcon
  label: string
  note: string
  value: string
}) {
  return (
    <div className="rounded-3xl border border-slate-200/70 bg-slate-50/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="rounded-2xl bg-white p-2 shadow-sm">
          <Icon className="size-4 text-slate-700" />
        </div>
        <span className="text-2xl font-semibold tracking-[-0.04em]">{value}</span>
      </div>
      <p className="text-sm font-medium text-slate-900">{label}</p>
      <p className="mt-1 text-sm text-slate-600">{note}</p>
    </div>
  )
}

function AccountCard({ account }: { account: DashboardAccountRow }) {
  const fresh = isFreshTimestamp(account.last_snapshot_at)
  const modelBuckets = getModelBuckets(account)

  return (
    <Card className="overflow-hidden border-white/60 bg-white/85 shadow-[0_24px_60px_-34px_rgba(15,23,42,0.55)] backdrop-blur">
      <CardHeader className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="font-heading text-2xl tracking-[-0.04em]">
                {account.label ?? account.account_key}
              </CardTitle>
              <Badge
                className={
                  fresh
                    ? 'rounded-full bg-emerald-100 text-emerald-800'
                    : 'rounded-full bg-amber-100 text-amber-900'
                }
              >
                {fresh ? 'Fresh' : 'Stale'}
              </Badge>
              {account.plan_type ? (
                <Badge variant="outline" className="rounded-full">
                  {account.plan_type}
                </Badge>
              ) : null}
            </div>
            <CardDescription className="text-sm text-slate-600">
              {account.email ?? 'No email reported yet'}
            </CardDescription>
          </div>

          <div className="text-right text-sm text-slate-500">
            <p className="font-medium text-slate-900">
              {formatRelativeTimestamp(account.last_snapshot_at)}
            </p>
            <p>{formatTimestamp(account.last_snapshot_at)}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MiniMetric
            label="5-hour"
            value={percentLabel(account.primary_remaining_percent)}
            tone={toneForRemaining(account.primary_remaining_percent)}
          />
          <MiniMetric
            label="Weekly"
            value={percentLabel(account.secondary_remaining_percent)}
            tone={toneForRemaining(account.secondary_remaining_percent)}
          />
          <MiniMetric
            label="Credits"
            value={
              account.unlimited_credits
                ? 'Unlimited'
                : account.credits_balance?.toString() ?? '0'
            }
            tone="slate"
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <UsageBar
          label={formatWindowLabel(account.primary_window_mins)}
          remaining={account.primary_remaining_percent}
          resetsAt={account.primary_resets_at}
        />
        <UsageBar
          label={formatWindowLabel(account.secondary_window_mins)}
          remaining={account.secondary_remaining_percent}
          resetsAt={account.secondary_resets_at}
        />

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">
                Model-specific buckets
              </h3>
              <p className="text-sm text-slate-500">
                Derived from the latest `rateLimitsByLimitId` payload.
              </p>
            </div>
            <Badge variant="outline" className="rounded-full">
              {modelBuckets.length} extra
            </Badge>
          </div>

          {modelBuckets.length ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200/80">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead>5-hour</TableHead>
                    <TableHead>Weekly</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelBuckets.map((bucket) => (
                    <TableRow key={bucket.key}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{bucket.label}</span>
                          <span className="text-xs text-slate-500">
                            {bucket.planType ?? 'plan unknown'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{percentLabel(bucket.primaryRemaining)}</TableCell>
                      <TableCell>{percentLabel(bucket.secondaryRemaining)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-500">
              No extra model-specific limits have been captured for this account yet.
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <MetaPill icon={Database} text={account.source_label ?? account.source_key} />
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <MetaPill
                  icon={FolderSymlink}
                  text={account.codex_home ?? 'No CODEX_HOME tracked'}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{account.codex_home ?? 'Missing codex home'}</TooltipContent>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  )
}

function LoadingCard() {
  return (
    <Card className="border-white/60 bg-white/75">
      <CardContent className="space-y-4 p-6">
        <div className="h-6 w-1/3 animate-pulse rounded-full bg-slate-200" />
        <div className="h-16 animate-pulse rounded-3xl bg-slate-100" />
        <div className="h-16 animate-pulse rounded-3xl bg-slate-100" />
        <div className="h-32 animate-pulse rounded-3xl bg-slate-100" />
      </CardContent>
    </Card>
  )
}

function SetupRow({ detail, file }: { detail: string; file: string }) {
  return (
    <div className="rounded-3xl border border-slate-200/80 bg-slate-50/70 p-4">
      <div className="mb-2 flex items-center gap-2 font-mono text-sm text-slate-900">
        <ArrowUpRight className="size-4" />
        {file}
      </div>
      <p className="text-sm leading-6 text-slate-600">{detail}</p>
    </div>
  )
}

function StepRow({ body, title }: { body: string; title: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-300">{body}</p>
    </div>
  )
}

function MetaPill({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
}

function MiniMetric({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'emerald' | 'amber' | 'rose' | 'slate'
  value: string
}) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-900'
      : tone === 'amber'
        ? 'bg-amber-50 text-amber-900'
        : tone === 'rose'
          ? 'bg-rose-50 text-rose-900'
          : 'bg-slate-100 text-slate-900'

  return (
    <div className={`rounded-3xl p-4 ${toneClass}`}>
      <p className="text-xs font-semibold tracking-[0.16em] uppercase">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.05em]">{value}</p>
    </div>
  )
}

function UsageBar({
  label,
  remaining,
  resetsAt,
}: {
  label: string
  remaining: number | null
  resetsAt: string | null
}) {
  const tone = toneForRemaining(remaining)
  const fillClass =
    tone === 'emerald'
      ? 'bg-emerald-500'
      : tone === 'amber'
        ? 'bg-amber-500'
        : tone === 'rose'
          ? 'bg-rose-500'
          : 'bg-slate-500'

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{label}</p>
          <p className="text-sm text-slate-500">
            Resets {resetsAt ? formatTimestamp(resetsAt) : 'when Codex reports it'}
          </p>
        </div>
        <p className="text-lg font-semibold tracking-[-0.04em] text-slate-900">
          {percentLabel(remaining)}
        </p>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all ${fillClass}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </div>
    </div>
  )
}

function toneForRemaining(remaining: number | null) {
  if (remaining == null) {
    return 'slate' as const
  }

  if (remaining <= 20) {
    return 'rose' as const
  }

  if (remaining <= 50) {
    return 'amber' as const
  }

  return 'emerald' as const
}

function percentLabel(value: number | null) {
  return value == null ? 'N/A' : `${value}%`
}
