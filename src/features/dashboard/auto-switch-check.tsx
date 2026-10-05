import { BadgeCheck } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Json } from '@/lib/database.types'

import { autoSwitchExplanation, readAutoSwitchMark } from './auto-switch-mark'

/** her-team#4148: the verified check on a plan in the auto-switch pool; hover or focus explains it. */
export function AutoSwitchCheck({ metadata, provider }: { metadata: Json | null | undefined; provider: 'claude' | 'codex' }) {
  const mark = readAutoSwitchMark(metadata)
  if (!mark?.inPool) return null
  const explanation = autoSwitchExplanation(provider, mark)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={explanation}
          className="inline-flex shrink-0 self-center text-sky-600 dark:text-sky-400"
          data-auto-switch-check=""
          role="img"
          tabIndex={0}
        >
          <BadgeCheck aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 leading-snug" side="top">
        {explanation}
      </TooltipContent>
    </Tooltip>
  )
}
