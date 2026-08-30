export interface RuntimeConfig {
  serverRuntimeConfig: Record<string, unknown>
  publicRuntimeConfig: Record<string, unknown>
}

// Client-graph bundler defines (see compat/register/bundler.ts). Mirrors the image-config
// pattern: the boolean twin gates the branch on a literal so the ?? never has to fold an
// object define, and the define is only emitted when publicRuntimeConfig is non-empty.
declare const __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINE__: Record<string, unknown>
declare const __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINED__: boolean

// Server: populated by config-loader's setConfig() at config load time. Client: inlined at
// build time from next.config's publicRuntimeConfig; serverRuntimeConfig never reaches the
// client bundle (matches Next's exact behavior).
const runtimeConfig: RuntimeConfig = {
  serverRuntimeConfig: {},
  publicRuntimeConfig:
    typeof __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINED__ === 'boolean'
      ? __PNEXT_PUBLIC_RUNTIME_CONFIG_INLINE__
      : {},
}

export default function getConfig(): RuntimeConfig {
  return runtimeConfig
}

export function setConfig(config: Partial<RuntimeConfig>) {
  Object.assign(runtimeConfig, config)
}
