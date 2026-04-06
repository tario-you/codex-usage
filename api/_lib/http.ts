export function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, init)
}

export function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, { status })
}
