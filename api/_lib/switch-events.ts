import { z } from 'zod'

import { SWITCH_EVENT_KINDS } from '../../src/shared/switch-history.js'

export {
  SWITCH_EVENT_KINDS,
  describeSwitchEvent,
  groupSwitchEvents,
  switchEventDedupeKey,
  type SwitchEventGroup,
  type SwitchEventKind,
  type SwitchEventView,
} from '../../src/shared/switch-history.js'

export const uploadedSwitchEventSchema = z.object({
  kind: z.enum(SWITCH_EVENT_KINDS),
  fromEmail: z.string().trim().toLowerCase().max(254).nullable().optional(),
  toEmail: z.string().trim().toLowerCase().max(254).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }),
})

export const uploadSwitchEventsSchema = z.object({
  deviceToken: z.string().min(1),
  events: z.array(uploadedSwitchEventSchema).max(200),
})
