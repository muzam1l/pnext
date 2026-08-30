import type { NextRequest } from '@wular/pnext/server'

export function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  return Response.json({ hello: searchParams.get('name') ?? 'world' })
}
