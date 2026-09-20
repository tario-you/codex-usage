import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'

import { ThemeProvider } from '@/components/theme/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppUpdateNotice } from '@/components/app-update-notice'

function RootLayout() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AppUpdateNotice />
        <Outlet />
        {import.meta.env.DEV ? (
          <>
            <ReactQueryDevtools buttonPosition="bottom-left" />
            <TanStackRouterDevtools position="bottom-right" />
          </>
        ) : null}
      </TooltipProvider>
    </ThemeProvider>
  )
}

export const Route = createRootRoute({
  component: RootLayout,
})
