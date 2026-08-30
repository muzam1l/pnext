/**
 * `PNEXT_DEV_RESTART_CACHE=0` turns off everything that makes a dev restart reuse work from the previous
 * process: the persisted client cache keys, the persisted next/font resolutions, and the boot-time proxy
 * and client-reference warmups. Nothing else changes, so a restart can be measured with and without the
 * whole group on one tree - the same bisect role `PNEXT_DISABLE_VENDOR_STAGE` plays for the vendor stage.
 */
export function restartCacheEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  return process.env.PNEXT_DEV_RESTART_CACHE !== '0'
}
