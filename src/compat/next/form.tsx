'use client'
/** @jsxImportSource preact */

import { useEffect, useRef, type JSX, type ReactNode } from 'preact/compat'
import { prefetchRoute, softNavigate } from '../../client/router'
import { addBasePath } from '../client/base-path'

type FormAction = string | ((formData: FormData) => void | Promise<void>)
export type FormProps = Omit<JSX.HTMLAttributes<HTMLFormElement>, 'action' | 'method'> & {
  action: FormAction
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean
  children?: ReactNode
}

export default function Form({
  action,
  replace,
  scroll,
  prefetch,
  onSubmit,
  children,
  ...formProps
}: FormProps) {
  const formRef = useRef<HTMLFormElement | null>(null)
  const stringAction = typeof action === 'string' ? action : undefined
  const basePathAction = stringAction == null ? undefined : addBasePath(stringAction)

  // Function actions are React form actions; pass through untouched so the
  // renderer wires them (no soft-nav interception, no GET semantics).

  useEffect(() => {
    if (basePathAction == null || prefetch === false) return
    // No prefetch in dev (per-request rendering); prefetchRoute already no-ops.
    // Register the form element so a revalidation-triggered retry re-prefetches
    // visible forms exactly like visible links (the router reads its `action`).
    void prefetchRoute(basePathAction, { element: formRef.current ?? undefined })
  }, [basePathAction, prefetch])

  if (typeof action !== 'string') {
    return (
      <form ref={formRef} action={action as never} onSubmit={onSubmit} {...formProps}>
        {children}
      </form>
    )
  }

  const handleSubmit = (event: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    onSubmit?.(event)
    if (event.defaultPrevented) return

    const form = event.currentTarget
    const submitter = (event as unknown as { submitter?: HTMLElement }).submitter as
      HTMLButtonElement | HTMLInputElement | undefined

    // A submitter that sets encType/method/target to a non-default value isn't
    // supported for soft-nav; fall back to the browser's native submit.
    if (submitter && hasUnsupportedSubmitterAttr(submitter)) return
    if (submitter && hasReactClientActionAttributes(submitter)) return

    event.preventDefault()

    const submitterAction = submitter?.getAttribute('formaction')
    const target = submitterAction != null ? submitterAction : addBasePath(action)
    const destination = createFormSubmitDestinationUrl(target, form)

    void softNavigate(destination.href, { replace, scroll })
  }

  return (
    <form
      ref={formRef}
      action={addBasePath(action)}
      method="get"
      onSubmit={handleSubmit}
      {...formProps}
    >
      {children}
    </form>
  )
}

export { Form }

// encType/method/target set to a non-default value can't be honored by a
// soft-nav GET; detect and warn so the caller falls back to native submit.
const SUBMITTER_ATTRS: { attr: string; name: string; defaults: string[] }[] = [
  { attr: 'formEncType', name: 'encType', defaults: ['application/x-www-form-urlencoded'] },
  { attr: 'formMethod', name: 'method', defaults: ['get'] },
  { attr: 'formTarget', name: 'target', defaults: ['', '_self'] },
]

function hasUnsupportedSubmitterAttr(submitter: HTMLButtonElement | HTMLInputElement) {
  for (const { attr, name, defaults } of SUBMITTER_ATTRS) {
    const raw = submitter.getAttribute(attr) ?? submitter.getAttribute(attr.toLowerCase())
    if (raw == null || raw === '') continue
    if (defaults.includes(raw.toLowerCase())) continue
    reportUnsupportedAttr(name)
    return true
  }
  return false
}

function hasReactClientActionAttributes(submitter: HTMLElement) {
  const name = submitter.getAttribute('name')
  return Boolean(name && (name.startsWith('$ACTION_ID_') || name.startsWith('$ACTION_REF_')))
}

function createFormSubmitDestinationUrl(action: string, form: HTMLFormElement) {
  let targetUrl: URL
  try {
    targetUrl = new URL(action, location.href)
  } catch (error) {
    throw new Error(`Cannot parse form action "${action}" as a URL`, {
      cause: error as Error,
    })
  }
  if (targetUrl.searchParams.size > 0) targetUrl.search = ''

  const data = new FormData(form)
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') {
      targetUrl.searchParams.append(key, value)
    } else {
      warnFileInput()
      targetUrl.searchParams.append(key, (value as File).name)
    }
  }
  return targetUrl
}

let reportedAttrs: Set<string> | undefined
function reportUnsupportedAttr(name: string) {
  if (typeof document === 'undefined' || !isDevDocument()) return
  reportedAttrs ??= new Set()
  if (reportedAttrs.has(name)) return
  reportedAttrs.add(name)
  console.error(
    `<Form>'s \`${name}\` was set to an unsupported value. Only the default value is supported. See https://nextjs.org/docs/app/api-reference/components/form`,
  )
}

let fileInputWarned = false
function warnFileInput() {
  if (fileInputWarned || typeof document === 'undefined' || !isDevDocument()) return
  fileInputWarned = true
  console.warn(
    '<Form> only supports file inputs if `action` is a function. Files will not be submitted with a string action.',
  )
}

function isDevDocument() {
  return (
    typeof document !== 'undefined' && Boolean(document.querySelector('script[data-pnext-dev]'))
  )
}
