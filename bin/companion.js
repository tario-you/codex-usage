#!/usr/bin/env node
import { startServer } from './lib/companion/server.js'
import { wrap } from './lib/companion/wrapper.js'
import { runClaudeHook } from './lib/companion/claude.js'

const [command = 'serve', ...args] = process.argv.slice(2)
try {
  if (command === 'serve') {
    const service = await startServer()
    console.log(`Task companion: ${service.origin}`)
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); process.exit(0) })
  } else if (command === 'wrap' && args[0] === '--' && args[1]) {
    process.exitCode = await wrap(args[1], args.slice(2))
  } else if (command === 'claude-hook') {
    await runClaudeHook()
  } else if (command === 'install' || command === 'uninstall') {
    const { install, uninstall } = await import('./lib/companion/install.js')
    console.log(JSON.stringify(command === 'install' ? await install(args) : await uninstall(), null, 2))
  } else throw new Error('Usage: codex-usage companion [serve | install --launcher /absolute/path | uninstall | claude-hook | wrap -- COMMAND ARGS...]')
} catch (error) {
  console.error(error.message); process.exitCode = 1
}
