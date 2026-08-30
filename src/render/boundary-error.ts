/**
 * Marker element carrying a server-subtree error across a client island's
 * boundary: the client entry turns it back into a throw at hydration, so the
 * island's own error boundary catches it.
 */
export const ISLAND_BOUNDARY_ERROR_ELEMENT = 'pnext-boundary-error'
export const ISLAND_BOUNDARY_ERROR_MESSAGE_ATTRIBUTE = 'data-pnext-error-message'
export const ISLAND_BOUNDARY_ERROR_DIGEST_ATTRIBUTE = 'data-pnext-error-digest'
