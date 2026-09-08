import { createFileRoute } from '@tanstack/react-router'

import { TeamSwitchboardPage } from '@/features/dashboard/team-switchboard-page'

export const Route = createFileRoute('/')({
  component: TeamSwitchboardPage,
})
