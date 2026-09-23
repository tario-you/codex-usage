import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateJson, readJson, stateRoot } from './store.js'

function records(directory) {
  try { return readdirSync(directory).filter(n => n.endsWith('.json')).flatMap(n => {
    try { return [readJson(path.join(directory, n), null)].filter(Boolean) } catch { return [] }
  }) } catch { return [] }
}
export function snapshot(root = stateRoot(), now = Date.now()) {
  const connections = records(path.join(root, 'connections')).filter(r => r.connected && r.at > now - 30_000).filter(r => {
    try { process.kill(r.pid, 0); return true } catch { return false }
  })
  const tasks = new Map()
  for (const connection of connections) for (const task of connection.tasks ?? []) {
    if (!tasks.has(task.threadId) || tasks.get(task.threadId).at < task.at) tasks.set(task.threadId, task)
  }
  return {
    enabled: readJson(path.join(root, 'settings.json'), { enabled: true }).enabled === true,
    connected: connections.length > 0,
    tasks: [...tasks.values()].sort((a, b) => b.at - a.at).slice(0, 100),
    claude: records(path.join(root, 'claude')).filter(r => r.waiting && r.at > now - 24 * 60 * 60_000),
  }
}
export async function startServer({ root = stateRoot(), port = 3212 } = {}) {
  const token = randomBytes(32).toString('hex')
  const assets = fileURLToPath(new URL('../../companion-ui/', import.meta.url))
  let origin
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: 'Invalid local host' })
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Cross-origin request denied' })
      const route = new URL(req.url, origin).pathname
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
        // The local page gets a session; other origins cannot read it or call APIs.
        if (route === '/') res.setHeader('Set-Cookie', `companion=${token}; HttpOnly; SameSite=Strict; Path=/`)
        res.writeHead(200, { 'Content-Type': route === '/' ? 'text/html' : route.endsWith('.js') ? 'text/javascript' : 'text/css' })
        res.end(readFileSync(path.join(assets, route === '/' ? 'index.html' : route.slice(1)))); return
      }
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('companion='))?.slice(10) || ''
      if (cookie.length !== token.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))) return json(401, { error: 'Open the companion page first' })
      if (req.method === 'GET' && route === '/api/status') return json(200, snapshot(root))
      if (req.method === 'POST' && route === '/api/settings') {
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return json(403, { error: 'Local JSON request required' })
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(413, { error: 'Request too large' }) }
        const input = JSON.parse(body)
        if (typeof input.enabled !== 'boolean') return json(400, { error: 'enabled must be a boolean' })
        privateJson(path.join(root, 'settings.json'), { enabled: input.enabled })
        return json(200, { enabled: input.enabled })
      }
      return json(404, { error: 'Not found' })
    } catch { return json(500, { error: 'Companion state unavailable' }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  privateJson(path.join(root, 'service.json'), { origin, pid: process.pid, startedAt: Date.now() })
  return { server, origin, close: () => new Promise(resolve => server.close(resolve)) }
}
