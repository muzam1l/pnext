// ---------------------------------------------------------------------------
// Registration seam for the next/navigation router hooks (COMPAT).
//
// The hooks themselves (useSelectedLayoutSegment(s), usePathname,
// useSearchParams, useParams) need no runtime registration: compat/aliases.ts maps
// `next/navigation` to compat/next/{navigation,client-navigation}.ts, and the
// per-layout segment scope is installed by the core renderer (render/slots.ts +
// render/renderer.ts applyLayouts), gated on next-compat.
//
// The ONE thing that must be wired centrally is canonical-URL tracking for
// usePathname()/useSearchParams() on rewrites. After a same-origin rewrite the
// downstream render sees the DESTINATION URL, so the hooks need the original
// (as-requested) URL recorded on the work unit. The rewrite feeder already calls
// recordRewrite(from, to) (src/proxy.ts proxyRewriteObserver + register-proxy.ts;
// config rewrites via register-proxy). The orchestrator should also call
// recordCanonicalUrl(from) at the SAME site(s) so the canonical URL is stashed
// before the request URL is replaced with the destination.
//
// Reason it is not wired here: the rewrite observer slot
// (setProxyRewriteObserver) is single-valued and owned by register-proxy.ts.
// registerNavigationHooks() is provided so register.ts can call it in one place;
// today it only re-exports the canonical setter for the proxy wiring.
// ---------------------------------------------------------------------------

export { recordCanonicalUrl, canonicalUrlHref } from '../next/canonical-url'

/**
 * Placeholder registration entry point kept for symmetry with the other register-<x> modules. The router
 * hooks are wired declaratively (module map + renderer seam); the only imperative wiring
 * (recordCanonicalUrl on rewrites) belongs in the proxy-rewrite observer.
 */
export function registerNavigationHooks(): void {
  // No-op: nothing to install at runtime beyond the declarative wiring above.
}
