/**
 * Progressive useActionState support, server side. After a no-JS form
 * submission runs `action(state, formData)`, the page re-renders with the
 * result as the form's state:
 *
 * - the consumed-once global override (`__PNEXT_ACTION_STATE__`) feeds the
 *   server render's useActionState initial value, and
 * - an inline script mirrors the same value to the browser so hydration
 *   adopts the updated state instead of the original initial state.
 */
export async function renderWithFormStateOverride(
  state: unknown,
  actionId: string,
  render: () => Promise<Response>,
): Promise<Response | null> {
  const initial = await render()
  if (initial.status !== 200) return null
  const contentType = initial.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) return null
  const skip = formStateCallsBefore(await initial.text(), actionId)
  if (skip === undefined) return null

  const holder = globalThis as { __PNEXT_ACTION_STATE__?: unknown }
  holder.__PNEXT_ACTION_STATE__ = { value: state, skip }
  try {
    const response = await render()
    if (response.status !== 200) return null
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return null
    const html = await response.text()
    const script = `<script>window.__PNEXT_ACTION_STATE__ = ${inlineJson({ value: state, skip })};</script>`
    const output = html.includes('</head>')
      ? html.replace('</head>', `${script}</head>`)
      : script + html
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(output, { status: 200, headers })
  } finally {
    delete holder.__PNEXT_ACTION_STATE__
  }
}

function formStateCallsBefore(html: string, actionId: string): number | undefined {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? []
  let count = 0
  for (const form of forms) {
    if (!form.includes('name="$pnext_form_state"')) continue
    const id = /name="\$pnext_action_id" value="([^"]+)"/.exec(form)?.[1]
    if (id === actionId) return count
    count++
  }
  return undefined
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/[<>&\u2028\u2029]/g, char => {
    switch (char) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      case '&':
        return '\\u0026'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
      default:
        return char
    }
  })
}
