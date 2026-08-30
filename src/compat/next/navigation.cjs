const router = {
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  bfcacheId: '',
}
const noop = () => undefined

exports.RedirectType = { push: 'push', replace: 'replace' }
exports.redirect = noop
exports.permanentRedirect = noop
exports.notFound = noop
exports.forbidden = noop
exports.unauthorized = noop
exports.useRouter = () => router
exports.usePathname = () => null
exports.useSearchParams = () => new URLSearchParams()
exports.useParams = () => ({})
exports.useRoute = () => ({
  route: null,
  pathname: '',
  params: {},
  searchParams: new URLSearchParams(),
})
exports.useSelectedLayoutSegment = () => null
exports.useSelectedLayoutSegments = () => []
exports.useLinkStatus = () => ({ pending: false })
