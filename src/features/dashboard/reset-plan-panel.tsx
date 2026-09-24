import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import type { DashboardAccountRow } from '@/lib/dashboard'
import { formatTimestamp } from '@/shared/codex'

import { formatWait } from '../../../bin/lib/reset-credits.js'

import { resetCreditChoice } from './reset-credit-choice'
import {
  buildResetPlan,
  type ResetPlanEvent,
  type ResetPlanRecommendation,
} from './reset-plan'

const MAX_FALLBACKS = 3
const MAX_UPCOMING_RESETS = 5

/**
 * One line answers "which account now, and what comes next". The full
 * fallback order and reset schedule stay one click away.
 */
export function ResetPlanPanel({ accounts }: { accounts: DashboardAccountRow[] }) {
  const [now, setNow] = useState(() => Date.now())
  const [isOpen, setIsOpen] = useState(false)
  const plan = buildResetPlan(accounts, now)
  // With nothing usable, the agent spends the reset credit that saves the most.
  const resetCredit = plan.current ? null : resetCreditChoice(accounts, now)

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const fallbacks = plan.fallbacks.slice(0, MAX_FALLBACKS)
  const nextReset = plan.upcomingResets[0] ?? null

  return (
    <section className="border-b border-border px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">
          {plan.current
            ? `Use ${plan.current.accountLabel}`
            : plan.nextAvailable
              ? `Resume with ${plan.nextAvailable.accountLabel}`
              : 'No usable balance yet'}
        </span>
        <span className="text-muted-foreground">
          {plan.current
            ? formatUsableBalance(plan.current)
            : plan.nextAvailable
              ? `${plan.nextAvailable.windowLabel} resets in ${formatTimeUntil(plan.nextAvailable.at, now)}`
              : 'Sync again to rebuild the plan.'}
        </span>
        {fallbacks.length > 0 ? (
          <span className="text-muted-foreground">
            then {fallbacks.map((fallback) => fallback.accountLabel).join(', ')}
          </span>
        ) : null}
        {resetCredit ? (
          <span className="text-muted-foreground">
            or spend {resetCredit.accountLabel}&apos;s reset{' '}
            {resetCredit.lastChance
              ? `(last chance: its plan ends in ${formatWait(resetCredit.savedMs)})`
              : `(saves ${formatWait(resetCredit.savedMs)})`}
          </span>
        ) : null}
        {nextReset ? (
          <span className="text-muted-foreground">
            next reset {formatTimeUntil(nextReset.at, now)} ({nextReset.accountLabel},{' '}
            {nextReset.windowLabel})
          </span>
        ) : null}
        <button
          aria-expanded={isOpen}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Reset plan
        </button>
      </div>

      {isOpen ? (
        <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Order
            </p>
            <ol className="mt-1.5 space-y-1">
              {plan.current ? (
                <li className="flex items-baseline gap-2">
                  <span className="w-4 text-muted-foreground">1.</span>
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{plan.current.accountLabel}</span>
                    <span className="text-muted-foreground"> · {formatUsableBalance(plan.current)}</span>
                  </span>
                </li>
              ) : null}
              {fallbacks.map((fallback, index) => (
                <li className="flex items-baseline gap-2" key={fallback.accountId}>
                  <span className="w-4 text-muted-foreground">{index + (plan.current ? 2 : 1)}.</span>
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{fallback.accountLabel}</span>
                    <span className="text-muted-foreground"> · {formatUsableBalance(fallback)}</span>
                  </span>
                </li>
              ))}
              {!plan.current && plan.nextAvailable ? (
                <li className="text-muted-foreground">
                  <NextAvailable event={plan.nextAvailable} now={now} />
                </li>
              ) : null}
            </ol>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Upcoming resets
            </p>
            {plan.upcomingResets.length > 0 ? (
              <ol className="mt-1.5 space-y-1">
                {plan.upcomingResets.slice(0, MAX_UPCOMING_RESETS).map((event) => (
                  <li
                    className="flex flex-wrap items-baseline gap-x-2"
                    key={`${event.accountId}-${event.windowKey}`}
                  >
                    <span className="w-14 font-medium text-foreground">
                      {formatTimeUntil(event.at, now)}
                    </span>
                    <span className="min-w-0 text-muted-foreground">
                      {event.accountLabel} · {event.windowLabel}
                      {event.projectedUsablePercent != null
                        ? ` · about ${event.projectedUsablePercent}% usable`
                        : ''}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1.5 text-muted-foreground">No future reset times were reported.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function NextAvailable({ event, now }: { event: ResetPlanEvent; now: number }) {
  return (
    <span>
      Resume with <span className="font-medium text-foreground">{event.accountLabel}</span>:{' '}
      {event.windowLabel} resets in {formatTimeUntil(event.at, now)} on{' '}
      {formatTimestamp(new Date(event.at))}
      {event.projectedUsablePercent != null
        ? `, about ${event.projectedUsablePercent}% usable then`
        : ''}
      .
    </span>
  )
}

function formatUsableBalance(recommendation: ResetPlanRecommendation) {
  const limitingWindow = recommendation.limitingWindowLabel
    ? ` (${recommendation.limitingWindowLabel})`
    : ''

  return `${recommendation.usablePercent}% usable${limitingWindow}`
}

function formatTimeUntil(timestamp: number, now: number) {
  const remainingMinutes = Math.max(0, Math.ceil((timestamp - now) / 60_000))
  const days = Math.floor(remainingMinutes / (24 * 60))
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60)
  const minutes = remainingMinutes % 60

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  return `${minutes}m`
}
