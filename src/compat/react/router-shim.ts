// Next's window.next router shim (COMPAT). Injected into the streamed document
// body so legacy `window.next.router` callers (tests eval it, older libraries
// poke it) see a pages-router-shaped surface: isReady, pathname/asPath/query
// backed by the __PNEXT_PAGES_DATA__ JSON node the materialized pages wrappers
// emit (fallback: location), and push/replace that prefer the soft-navigation
// runtime (window.__PNEXT_ROUTER__) with a hard-navigation fallback.
export function nextRouterShimScript(): string {
  return (
    '<script>window.next=window.next||{};window.next.version=window.next.version||"16.3.0";(function(){' +
    'var r=window.next.router=window.next.router||{};' +
    'function d(){try{var n=document.getElementById("__PNEXT_PAGES_DATA__");' +
    'return n&&n.textContent?JSON.parse(n.textContent):null}catch(e){return null}}' +
    'function q(){var s=d(),o={};if(s&&s.query){for(var k in s.query)o[k]=s.query[k]}' +
    'new URLSearchParams(location.search).forEach(function(v,k){if(k!=="_rsc")o[k]=v});return o}' +
    'r.isReady=true;r.isFallback=r.isFallback||false;' +
    'if(!Object.getOwnPropertyDescriptor(r,"query"))Object.defineProperty(r,"query",{get:q,configurable:true});' +
    'if(!Object.getOwnPropertyDescriptor(r,"pathname"))Object.defineProperty(r,"pathname",{get:function(){var s=d();return(s&&s.pathname)||location.pathname},configurable:true});' +
    'if(!Object.getOwnPropertyDescriptor(r,"asPath"))Object.defineProperty(r,"asPath",{get:function(){return location.pathname+location.search},configurable:true});' +
    'r.push=r.push||function(href){var s=String(href);' +
    'if(window.__PNEXT_ROUTER__&&window.__PNEXT_ROUTER__.navigate){return window.__PNEXT_ROUTER__.navigate(s).then(function(){return true})}' +
    'location.assign(s);return Promise.resolve(true)};' +
    'r.replace=r.replace||function(href){location.replace(String(href));return Promise.resolve(true)};' +
    'r.prefetch=r.prefetch||function(){return Promise.resolve(null)};' +
    '})();</script>'
  )
}
