/**
 * The error a server-action dispatch throws when the server no longer
 * recognizes the action id (client/server version skew). Mirrors Next's
 * `UnrecognizedActionError`: a named Error subclass so
 * `unstable_isUnrecognizedActionError` can identify it via `instanceof`
 * (message text is not part of the contract). The client runtime throws it when
 * the action RPC comes back 404 with the `x-nextjs-action-not-found` marker so a
 * user error boundary can catch it and recover (e.g. prompt a page reload).
 */
export class UnrecognizedActionError extends Error {
  constructor(...args: ConstructorParameters<typeof Error>) {
    super(...args)
    this.name = 'UnrecognizedActionError'
  }
}

/**
 * True for the error a server-action dispatch throws when the server did not
 * recognize the action id. Recognizes the typed error by `instanceof`, and (as
 * a fallback for errors that crossed a serialization boundary and lost their
 * prototype) by the name/message the endpoint sends.
 */
export function isUnrecognizedActionError(error: unknown): boolean {
  if (error instanceof UnrecognizedActionError) return true
  return (
    error instanceof Error &&
    (error.name === 'UnrecognizedActionError' ||
      / was not found on the server\.?$/.test(error.message))
  )
}
