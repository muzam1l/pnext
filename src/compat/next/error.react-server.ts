export type { ErrorInfo } from './error'

export function catchError(): never {
  throw new Error('`catchError` can only be used in Client Components.')
}
