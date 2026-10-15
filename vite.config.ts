import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { config as loadEnvFile } from 'dotenv'
import { defineConfig } from 'vite'

const rootDir = path.resolve(__dirname)

for (const fileName of ['.env.collector.local', '.env.local', '.env']) {
  loadEnvFile({ path: path.join(rootDir, fileName), override: false })
}

type RouteHandler = (request: Request) => Promise<Response>

const devRouteHandlers: Record<string, Partial<Record<string, RouteHandler>>> = {
  '/api/accounts/usage-override': {
    POST: async (request) => {
      const module = await import('./api/accounts/usage-override')
      return module.POST(request)
    },
  },
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

async function resolveLoginDevHandler(
  method: string,
  pathname: string,
): Promise<RouteHandler | undefined> {
  const module = await import('./api/login')
  const handler = module.resolveLoginRoute(method, pathname)
  return handler ?? undefined
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
        const handler = url.pathname.startsWith('/api/login/')
          ? await resolveLoginDevHandler(method, url.pathname)
          : devRouteHandlers[url.pathname]?.[method]

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

// The version changes only when what the browser runs changes, so a deploy that touches only the API or the
// collector leaves every script's hash, and a returning visitor's cache, as it was.
function clientVersion() {
  const hash = createHash('sha256')
  const files = ['index.html', 'package-lock.json', 'vite.config.ts']
  for (const dir of ['src', 'public']) {
    for (const entry of readdirSync(path.join(rootDir, dir), { recursive: true })) {
      const file = path.join(dir, String(entry))
      if (statSync(path.join(rootDir, file)).isFile()) files.push(file)
    }
  }
  for (const file of files.sort()) hash.update(file).update(readFileSync(path.join(rootDir, file)))
  for (const key of Object.keys(process.env).filter((name) => name.startsWith('VITE_')).sort()) {
    hash.update(`${key}=${process.env[key]}`)
  }
  return hash.digest('hex').slice(0, 16)
}

const appVersion = clientVersion()
export default defineConfig({
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion) },
  plugins: [localApiRoutesPlugin(), react(), tailwindcss(), {
    name: 'dashboard-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: appVersion }) })
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries sit in their own chunks, so a deploy that changes only our code leaves them cached (assets are
        // immutable) and a returning visitor downloads just the small app chunk again.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
            { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
})
