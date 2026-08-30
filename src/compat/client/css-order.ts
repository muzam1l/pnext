// Next preserves the incoming document's stylesheet precedence on soft nav.
// Shared links otherwise retain their old position while newly-needed links
// append, which reverses ties in the CSS cascade after a route transition.
export function reconcileNextStylesheets(incoming: Document) {
  const order = new Map<string, number>()
  for (const link of incoming.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const href = absoluteHref(link)
    if (href && nextStylesheet(href) && !order.has(href)) order.set(href, order.size)
  }
  if (order.size < 2) return

  const current = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
  ].filter(link => order.has(link.href))
  if (current.length < 2) return

  const rank = (link: HTMLLinkElement) => order.get(link.href) ?? 0
  if (current.every((link, index) => index === 0 || rank(current[index - 1]!) <= rank(link))) return

  const sorted = [...current].sort((left, right) => rank(left) - rank(right))
  let previous = sorted[0]!
  for (const link of sorted.slice(1)) {
    if (previous.nextSibling !== link) previous.after(link)
    previous = link
  }
}

function absoluteHref(link: HTMLLinkElement) {
  const href = link.getAttribute('href')
  return href ? new URL(href, location.href).href : undefined
}

function nextStylesheet(href: string) {
  const url = new URL(href, location.href)
  return url.origin === location.origin && url.pathname.startsWith('/_next/static/')
}
