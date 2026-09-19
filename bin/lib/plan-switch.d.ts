export interface PlanSwitchAgentConfig {
  deviceToken?: string | null
  syncUrl?: string | null
}

export interface PendingPlanSwitch {
  email: string
  requestId: string
}

export interface PlanSwitchOutcome {
  detail: string | null
  email: string
  outcome: 'switched' | 'failed'
  requestId: string | null
}

export type PlanSwitcher = (input: {
  email: string
  fetcher?: typeof fetch
  stateDir?: string
  storePath?: string
}) => Promise<{ email: string }>

export const SWITCHBOARD_STATE_DIR: string
export const PLAN_SWITCH_POLL_SECONDS: number
export function readSwitchboardEndpoint(stateDir?: string): { origin: string; token: string } | null
export function readActiveEmail(codexHome: string): string | null
export function pendingSwitchFromPoll(payload: unknown): PendingPlanSwitch | null
export const switchThroughSwitchboard: PlanSwitcher
export function pollPlanSwitch(input: {
  activeEmail: string | null
  config: PlanSwitchAgentConfig
  fetcher?: typeof fetch
}): Promise<PendingPlanSwitch | null>
export function reportPlanSwitch(input: {
  config: PlanSwitchAgentConfig
  fetcher?: typeof fetch
  result: PlanSwitchOutcome
}): Promise<void>
export function runPlanSwitchPass(input: {
  codexHome: string
  config: PlanSwitchAgentConfig
  fetcher?: typeof fetch
  log?: (message: string) => void
  stateDir?: string
  storePath?: string
  switcher?: PlanSwitcher
}): Promise<boolean>
