import { readFile } from 'node:fs/promises'

import { errorResponse } from './_lib/http'

const CLI_FILE_URL = new URL('../bin/codex-usage.js', import.meta.url)

export async function GET() {
  try {
    const source = await readFile(CLI_FILE_URL, 'utf8')

    return new Response(source, {
      headers: {
        'cache-control': 'no-store',
        'content-disposition': 'inline; filename="codex-usage.js"',
        'content-type': 'application/javascript; charset=utf-8',
      },
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to load CLI.'
    return errorResponse(message, 500)
  }
}
