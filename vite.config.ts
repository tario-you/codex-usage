import { Buffer } from 'node:buffer'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { config as loadEnvFile } from 'dotenv'
import { defineConfig } from 'vite'

const rootDir = path.resolve(__dirname)

for (const fileName of ['.env.collector.local', '.env.local', '.env']) {
  loadEnvFile({ path: path.join(rootDir, fileName), override: false })
}

type RouteHandler = (request: Request) => Promise<Response>

const devRouteHandlers: Record<string, Partial<Record<string, RouteHandler>>> = {
  '/api/accounts/unlink': {
    POST: async (request) => {
      const module = await import('./api/accounts/unlink')
      return module.POST(request)
    },
  },
  '/api/shares/accept': {
    POST: async (request) => {
      const module = await import('./api/shares/accept')
      return module.POST(request)
    },
  },
  '/api/shares/preview': {
    GET: async (request) => {
      const module = await import('./api/shares/preview')
      return module.GET(request)
    },
  },
  '/api/shares/start': {
    POST: async (request) => {
      const module = await import('./api/shares/start')
      return module.POST(request)
    },
  },
  '/api/cli': {
    GET: async () => {
      const module = await import('./api/cli')
      return module.GET()
    },
  },
  '/api/connect/open': {
    POST: async (request) => {
      const module = await import('./api/connect/open')
      return module.POST(request)
    },
  },
  '/api/connect/start': {
    POST: async (request) => {
      const module = await import('./api/connect/start')
      return module.POST(request)
    },
  },
  '/api/pair/complete': {
    POST: async (request) => {
      const module = await import('./api/pair/complete')
      return module.POST(request)
    },
  },
  '/api/pair/start': {
    POST: async (request) => {
      const module = await import('./api/pair/start')
      return module.POST(request)
    },
  },
  '/api/sync': {
    POST: async (request) => {
      const module = await import('./api/sync')
      return module.POST(request)
    },
  },
}

function localApiRoutesPlugin() {
  return {
    configureServer(server: {
      middlewares: {
        use: (
          handler: (
            req: IncomingMessage,
            res: ServerResponse,
            next: (error?: unknown) => void,
          ) => void | Promise<void>,
        ) => void
      }
    }) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url
        if (!requestUrl) {
          next()
          return
        }

        const url = new URL(requestUrl, `http://${req.headers.host ?? 'localhost:5173'}`)
        const method = req.method ?? 'GET'
        const handler = devRouteHandlers[url.pathname]?.[method]

        if (!handler) {
          next()
          return
        }

        try {
          const body = await readNodeRequestBody(req)
          const response = await handler(
            new Request(url, {
              body: method === 'GET' || method === 'HEAD' ? undefined : body,
              headers: toHeaders(req),
              method,
            }),
          )

          await writeNodeResponse(res, response)
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unexpected dev API failure.',
            }),
          )
        }
      })
    },
    name: 'local-api-routes',
  }
}

async function readNodeRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks)
}

function toHeaders(req: IncomingMessage) {
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry)
      }
      continue
    }

    if (value) {
      headers.set(key, value)
    }
  }

  return headers
}

async function writeNodeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status

  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  const body = await response.arrayBuffer()
  res.end(Buffer.from(body))
}

export default defineConfig({
  plugins: [localApiRoutesPlugin(), tanstackRouter(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
