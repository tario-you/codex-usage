import { useEffect, useState } from 'react'

import type { DashboardAccountRow } from '@/lib/dashboard'
import { formatTimestamp } from '@/shared/codex'

import {
  buildResetPlan,
  type ResetPlanEvent,
  type ResetPlanRecommendation,
} from './reset-plan'

const MAX_FALLBACKS = 3
const MAX_UPCOMING_RESETS = 5

export function ResetPlanPanel({ accounts }: { accounts: DashboardAccountRow[] }) {
  const [now, setNow] = useState(() => Date.now())
  const plan = buildResetPlan(accounts, now)

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  return (
    <section className="border-b border-border px-4 py-4 sm:px-5">
      <div>
        <p className="font-medium text-foreground">Reset plan</p>
        <p className="text-sm text-muted-foreground">
          Account order uses each usable balance and nearest reset. It updates
          with every sync.
        </p>
      </div>

      <div className="mt-4 grid gap-5 md:grid-cols-2 md:gap-0">
        <div className="md:border-r md:border-border md:pr-5">
          <h3 className="text-sm font-medium text-foreground">
            {plan.current ? 'Use now' : 'When to resume'}
          </h3>

          {plan.current ? (
            <CurrentRecommendation now={now} recommendation={plan.current} />
          ) : plan.nextAvailable ? (
            <NextAvailable event={plan.nextAvailable} now={now} />
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No usable balance or future reset is available yet. Sync again to
              rebuild the plan.
            </p>
          )}

          {plan.fallbacks.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-foreground">
                If that account runs out
              </h3>
              <ol className="mt-2 divide-y divide-border border-y border-border">
                {plan.fallbacks.slice(0, MAX_FALLBACKS).map((fallback, index) => (
                  <li
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-2.5 text-sm"
                    key={fallback.accountId}
                  >
                    <span className="text-muted-foreground">{index + 1}.</span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        Switch to {fallback.accountLabel}
                      </p>
                      <p className="text-muted-foreground">
                        {formatUsableBalance(fallback)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : plan.current && plan.upcomingResets.length > 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No backup account has usable balance. If this runs out, wait for
              the next reset shown here.
            </p>
          ) : null}
        </div>

        <div className="border-t border-border pt-4 md:border-t-0 md:pt-0 md:pl-5">
          <h3 className="text-sm font-medium text-foreground">Upcoming resets</h3>
          {plan.upcomingResets.length > 0 ? (
            <ol className="mt-2 divide-y divide-border border-y border-border">
              {plan.upcomingResets
                .slice(0, MAX_UPCOMING_RESETS)
                .map((event) => (
                  <ResetEvent event={event} key={`${event.accountId}-${event.windowKey}`} now={now} />
                ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No future reset times were reported.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function CurrentRecommendation({
  now,
  recommendation,
}: {
  now: number
  recommendation: ResetPlanRecommendation
}) {
  return (
    <div className="mt-2 border-l-2 border-chart-1 pl-3">
      <p className="font-medium text-foreground">{recommendation.accountLabel}</p>
      <p className="text-sm text-muted-foreground">
        {formatUsableBalance(recommendation)}
      </p>
      {recommendation.nextResetAt && recommendation.nextResetWindowLabel ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Next {recommendation.nextResetWindowLabel} reset is in{' '}
          {formatTimeUntil(recommendation.nextResetAt, now)}.
        </p>
      ) : null}
    </div>
  )
}

function NextAvailable({ event, now }: { event: ResetPlanEvent; now: number }) {
  return (
    <div className="mt-2 border-l-2 border-chart-1 pl-3">
      <p className="font-medium text-foreground">
        Resume with {event.accountLabel}
      </p>
      <p className="text-sm text-muted-foreground">
        {event.windowLabel} resets in {formatTimeUntil(event.at, now)} on{' '}
        {formatTimestamp(new Date(event.at))}.
        {event.projectedUsablePercent != null
          ? ` About ${event.projectedUsablePercent}% should be usable then.`
          : ''}
      </p>
    </div>
  )
}

function ResetEvent({
  event,
  now,
}: {
  event: ResetPlanEvent
  now: number
}) {
  return (
    <li className="grid gap-1 py-2.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <div>
        <p className="font-medium text-foreground">
          {formatTimeUntil(event.at, now)}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatTimestamp(new Date(event.at))}
        </p>
      </div>
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">
          {event.accountLabel}
        </p>
        <p className="text-muted-foreground">
          {event.windowLabel} renews
          {event.projectedUsablePercent != null
            ? ` · about ${event.projectedUsablePercent}% usable`
            : ''}
        </p>
      </div>
    </li>
  )
}

function formatUsableBalance(recommendation: ResetPlanRecommendation) {
  const limitingWindow = recommendation.limitingWindowLabel
    ? ` · limited by ${recommendation.limitingWindowLabel}`
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
