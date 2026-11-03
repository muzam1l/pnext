export {
  forbidden,
  notFound,
  permanentRedirect,
  ReadonlyURLSearchParams,
  redirect,
  RedirectType,
  unauthorized,
  unstable_rethrow,
} from './navigation'

export function unstable_isUnrecognizedActionError(): never {
  throw new Error('`unstable_isUnrecognizedActionError` can only be used on the client.')
}
