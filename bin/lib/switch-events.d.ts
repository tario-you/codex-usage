import type { SwitchEventKind } from '../../src/shared/switch-history'

export interface SwitchboardActivityEntry {
  type: string
  accountId: string | null
  message?: string | null
  at: string
}

export interface UploadableSwitchEvent {
  kind: SwitchEventKind
  fromEmail: string | null
  toEmail: string | null
  reason: string | null
  occurredAt: string
}

export const SWITCHBOARD_ACTIVITY_PATH: string
export function readSwitchboardActivity(activityPath?: string): SwitchboardActivityEntry[]
export function readSwitcherEmails(storePath?: string): Map<string, string>
export function buildSwitchEventUpload(input: {
  entries: SwitchboardActivityEntry[]
  emailsById: Map<string, string>
  uploadedAt: string | null
}): UploadableSwitchEvent[]
export function uploadSwitchEvents(input: {
  config: { deviceToken?: string | null; apiBaseUrl?: string | null; switchEventsUploadedAt?: string | null }
  fetcher?: typeof fetch
}): Promise<{ uploaded: number; uploadedAt: string | null }>
