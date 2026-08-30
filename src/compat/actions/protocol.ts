/**
 * Wire contract shared by the client runtime and the server endpoint. Keeping
 * the constants in one place guarantees the two sides never drift.
 *
 * The wire shape mirrors Next.js where tests can observe it:
 * - Actions POST to the CURRENT PAGE URL (not a bespoke endpoint) with the
 *   action id in the `next-action` header.
 * - JSON-args bodies use content-type text/plain; form submissions send
 *   multipart/form-data (or urlencoded for no-JS submits).
 * - Server errors come back as text/plain; the client treats any non-ok
 *   response with a different content-type as "unexpected response".
 */

/** Header carrying the action id from client -> server. Mirrors Next's name. */
export const ACTION_ID_HEADER = 'next-action'

/**
 * Response header set on a redirect result so the client can distinguish a
 * framework redirect (soft-navigable) from an arbitrary 303 it should follow.
 */
export const ACTION_REDIRECT_HEADER = 'x-action-redirect'

/**
 * Response header telling the client to soft-refresh the current route after a
 * successful action: set when the action revalidated data (revalidatePath/
 * revalidateTag) or mutated cookies, mirroring when Next invalidates its
 * client router cache.
 */
export const ACTION_REFRESH_HEADER = 'x-pnext-action-refresh'

/** Next's public action revalidation header. `1` means static+dynamic invalidated. */
export const NEXT_ACTION_REVALIDATED_HEADER = 'x-action-revalidated'

/** Response header marking a notFound() result (body is the 404 page HTML). */
export const ACTION_NOT_FOUND_HEADER = 'x-pnext-action-not-found'

/**
 * Next's own action-not-found marker (`x-nextjs-action-not-found`). Set on the
 * 404 response for an unknown/unrecognized action id so tooling and the
 * no-server-actions suite observe it; distinct from ACTION_NOT_FOUND_HEADER,
 * which drives the client's 404-page swap for a notFound() result.
 */
export const NEXT_ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found'

/** Response header carrying redirect(location, RedirectType.replace) intent. */
export const REDIRECT_TYPE_HEADER = 'x-pnext-redirect-type'

/**
 * Response header carrying the boundary digest of a masked action error. Next
 * transports the digest to the client so a caught action error exposes
 * `error.digest`; the redacted 500 body hides the message, so the digest rides
 * this header and the client stamps it onto the thrown Error. Computed with the
 * same deterministic scheme as the render boundary digest (error-serialize.ts),
 * so it matches the `digest: '<digest>'` line printed to the server log.
 */
export const ACTION_ERROR_DIGEST_HEADER = 'x-pnext-action-error-digest'

/** Argument marker for a server-action function reference passed as an arg. */
export const ARG_ACTION_MARKER = '$$pnext_action_ref'

/**
 * Hidden form field carrying the action id for no-JS progressive enhancement, emitted in
 * <form action={serverAction}> so a plain HTML submit - which cannot set the next-action header -
 * still identifies the form's action. A per-button `formAction` override uses SUBMIT_ACTION_ID_FIELD
 * instead so it is unambiguous regardless of DOM order: the form-level field renders LAST inside
 * client-island forms, so a shared field name could not tell the two apart.
 */
export const ACTION_ID_FIELD = '$pnext_action_id'

/**
 * Field name a `<button formAction>` submitter carries its action id under, submitted only when it is
 * the submitter. Distinct from ACTION_ID_FIELD so the server can prefer a submitter override over the
 * surrounding form's default without relying on field order - a no-JS submit has no `event.submitter`
 * to disambiguate them.
 */
export const SUBMIT_ACTION_ID_FIELD = '$pnext_submit_action_id'

/**
 * Multipart field name carrying the JSON-encoded argument list when a call
 * mixes JSON args with FormData/File values (e.g. bound args ahead of a form
 * submission). Slots reference the other multipart parts.
 */
export const ACTION_ARGS_FIELD = '$pnext_args'

/**
 * Hidden form field carrying a useActionState form's CURRENT state (JSON) for
 * no-JS progressive submissions. The server runs `action(state, formData)` and
 * re-renders the page with the result as the form's new state.
 */
export const FORM_STATE_FIELD = '$pnext_form_state'

/** Marker key for a FormData argument slot inside ACTION_ARGS_FIELD JSON. */
export const ARG_FORMDATA_MARKER = '$$pnext_fd'

/** Marker key for a File argument slot inside ACTION_ARGS_FIELD JSON. */
export const ARG_FILE_MARKER = '$$pnext_file'

/** Prefix for multipart parts belonging to a FormData argument slot. */
export const ARG_FORMDATA_PREFIX = '$pnext_fd_'

/** Prefix for multipart parts holding a File argument slot. */
export const ARG_FILE_PREFIX = '$pnext_file_'

/** Serialized-prop marker for a server-action function passed to an island. */
export const PROP_ACTION_MARKER = '$$pnextAction'

/** Maximum action argument list length, mirroring Next's guard. */
export const MAX_ACTION_ARGS = 1000

export function tooManyArgsMessage(count: number) {
  return `Server Action arguments list is too long (${count}). Maximum allowed is ${MAX_ACTION_ARGS}.`
}

/**
 * The exact text a masked production action error renders as on the client (React's minified
 * flight-client error). Next's e2e tests assert this string verbatim via their error boundaries, so
 * prod builds send it as the text/plain error body and the client throws it as the Error message.
 */
export const MASKED_ACTION_ERROR =
  'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

/** JSON success envelope: { data } (application/json, status 200). */
export interface ActionSuccessBody {
  data: unknown
}
