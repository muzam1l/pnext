export const PAGE_SIZE = 25

export interface Page {
  page: number
  pages: number
  start: number
  end: number
  total: number
}

export type Params = Record<string, string | string[] | undefined>

export const param = (params: Params, key: string) => {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

export function pageOf(params: Params, total: number, size = PAGE_SIZE): Page {
  const pages = Math.max(1, Math.ceil(total / size))
  const raw = Number(param(params, 'page'))
  const page = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), pages) : 1
  return { page, pages, start: (page - 1) * size, end: Math.min(page * size, total), total }
}

export const slice = <T>(rows: T[], page: Page) => rows.slice(page.start, page.end)
