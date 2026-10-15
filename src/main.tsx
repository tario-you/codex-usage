import { StrictMode } from 'react'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'

import './index.css'
import { AppUpdateNotice } from './components/app-update-notice'
import { initializeTheme } from './components/theme/theme'
import { ThemeProvider } from './components/theme/theme-provider'
import { TooltipProvider } from './components/ui/tooltip'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { queryClient } from './lib/query-client'

initializeTheme()

// The dashboard is the site's one page and reads its own URL, so it renders directly, without a router in the first script.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <AppUpdateNotice />
          <DashboardPage />
          {import.meta.env.DEV ? <ReactQueryDevtools buttonPosition="bottom-left" /> : null}
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
