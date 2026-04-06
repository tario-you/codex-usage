import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { createRoot } from 'react-dom/client'

import './index.css'
import { initializeTheme } from './components/theme/theme'
import { queryClient } from './lib/query-client'
import { router } from './router'

initializeTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
