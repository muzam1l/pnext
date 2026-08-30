import ReactDomCompat, { preconnect, prefetchDNS, preinit, preload, version } from './dom'

const ReactDomServer = { ...ReactDomCompat } as typeof ReactDomCompat & {
  useFormState?: unknown
  useFormStatus?: unknown
  requestFormReset?: unknown
}

delete ReactDomServer.useFormState
delete ReactDomServer.useFormStatus
delete ReactDomServer.requestFormReset

export { preconnect, prefetchDNS, preinit, preload, version }
export {
  ReactDOMSharedInternals as __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
  ReactDOMSharedInternals as __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} from './internals'
export default ReactDomServer
