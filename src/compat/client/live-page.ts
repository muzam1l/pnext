// A client page re-renders with the current URL's searchParams on every history update, shallow
// pushState/replaceState included, like Next's router does. Each value is pre-fulfilled so use()
// never suspends on it.
import { h, type ComponentType } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { patchHistory } from '../../api/client-navigation'
import { locationListeners } from '../../client/router/events'

interface PageProps {
  searchParams?: unknown
}

export function LivePage({ Page, props }: { Page: ComponentType<PageProps>; props: PageProps }) {
  const [initial] = useState(location.search)
  const [search, setSearch] = useState(initial)
  useEffect(() => {
    patchHistory()
    const listener = () => setSearch(location.search)
    locationListeners().add(listener)
    listener()
    return () => {
      locationListeners().delete(listener)
    }
  }, [])
  const live = useMemo(() => {
    if (search === initial) return props
    const value = searchParamsObject(search)
    return {
      ...props,
      searchParams: Object.assign(Promise.resolve(value), { status: 'fulfilled', value }),
    }
  }, [search, initial, props])
  return h(Page, live)
}

// Repeated keys collect into arrays (Next's searchParams page-prop shape).
function searchParamsObject(search: string): Record<string, string | string[]> {
  const result = Object.create(null) as Record<string, string | string[]>
  new URLSearchParams(search).forEach((value, key) => {
    const current = result[key]
    if (current === undefined) result[key] = value
    else if (Array.isArray(current)) current.push(value)
    else result[key] = [current, value]
  })
  return result
}
