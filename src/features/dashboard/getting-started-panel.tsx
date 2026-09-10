import { Eye, Laptop, Share2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The three things a person can do here, each with its exact next click.
 * Shown by itself when nothing is paired yet, and on demand from the header.
 */
export function GettingStartedPanel({
  onAddMachine,
  onDismiss,
  onInviteViewer,
}: {
  onAddMachine: () => void
  onDismiss?: () => void
  onInviteViewer: () => void
}) {
  const steps = [
    {
      action: (
        <Button onClick={onAddMachine} size="sm" type="button" variant="outline">
          Add a machine
        </Button>
      ),
      detail:
        'Run the command you get on the machine where you use Codex. That machine reports how much of each plan is left. Nothing else changes on it.',
      icon: Laptop,
      title: 'See your own usage here',
    },
    {
      action: (
        <Button asChild size="sm" type="button" variant="outline">
          <a href="#share-codex-login">Share Codex login</a>
        </Button>
      ),
      detail:
        'Create a login command in the Share Codex login card and send it to them. They run it once in Terminal and keep that window open. Their Codex signs into your next usable plan and moves on by itself when one runs out.',
      icon: Share2,
      title: 'Let someone use your plans',
    },
    {
      action: (
        <Button onClick={onInviteViewer} size="sm" type="button" variant="outline">
          Invite a viewer
        </Button>
      ),
      detail:
        'Send them the invite link. They sign in with Google and see your dashboard read-only. They cannot use your plans from it.',
      icon: Eye,
      title: 'Let someone look',
    },
  ]

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>How this works</CardTitle>
          <CardDescription>
            Codex usage shows how much of every Codex plan is left and switches machines to the
            next plan automatically. Pick what you want to do:
          </CardDescription>
        </div>
        {onDismiss ? (
          <Button
            aria-label="Hide this guide"
            onClick={onDismiss}
            size="icon-sm"
            title="Hide this guide"
            type="button"
            variant="ghost"
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li
              className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
              key={step.title}
            >
              <div className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                <step.icon className="size-3.5 text-muted-foreground" />
                <p className="font-medium text-foreground">{step.title}</p>
              </div>
              <p className="flex-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              <div>{step.action}</div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
