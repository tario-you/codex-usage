import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'

import { TooltipProvider } from '@/components/ui/tooltip'

function RootLayout() {
  return (
    <TooltipProvider>
      <Outlet />
      {import.meta.env.DEV ? (
        <>
          <ReactQueryDevtools buttonPosition="bottom-left" />
          <TanStackRouterDevtools position="bottom-right" />
        </>
      ) : null}
    </TooltipProvider>
  )
}

export const Route = createRootRoute({
  component: RootLayout,
})
