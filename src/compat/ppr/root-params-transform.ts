// next/root-params import rewrite (COMPAT).
//
// `next/root-params` exports one async getter per root param. The set of names is app-specific, so a
// static alias module cannot list them as named exports - a bare `import { lang } from
// 'next/root-params'` would fail at bundle time with "no matching export". This transform rewrites such
// imports into named bindings pulled off the module's default Proxy, which resolves any getter:
//
//   import { lang, locale as l } from 'next/root-params';
//     -> import __pnextRootParams from 'next/root-params';
//        const lang = __pnextRootParams.lang;
//        const l = __pnextRootParams.locale;
//
// The alias map still resolves the specifier to compat/next/root-params.ts, so the default import binds
// the Proxy. Build-time validation that a name is actually a root param lives in root-params-scan.ts;
// this transform stays permissive.

import { isIdentifier, uniqueIdentifier } from '../../utils/code'

const ROOT_PARAMS_SPECIFIER = /['"]next\/root-params['"]/

// `[^}]` for the clause, never a lazy `[\s\S]*?`: the latter backtracks across
// an earlier `import { X } from 'react'` and swallows that line too.
const IMPORT_RE =
  /^[ \t]*import\s+\{([^}]*)\}\s+from\s+['"]next\/root-params['"]\s*;?[ \t]*(?:\r?\n)?/gm

interface Binding {
  imported: string
  local: string
}

function parseBindings(clause: string): Binding[] {
  return clause
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => {
      if (part.startsWith('type ')) return []
      const [importedRaw, localRaw] = part.split(/\s+as\s+/)
      const imported = importedRaw?.trim()
      const local = (localRaw ?? importedRaw)?.trim()
      if (!imported || !local || !isIdentifier(imported) || !isIdentifier(local)) return []
      return [{ imported, local }]
    })
}

/**
 * Rewrite `next/root-params` named imports to default-Proxy member reads.
 * A no-op for sources that do not import the module. Registered as a server
 * source transform and applied in the client bundler plugin.
 */
export function rewriteRootParamsSource(source: string): string {
  if (!ROOT_PARAMS_SPECIFIER.test(source)) return source
  const proxyName = uniqueIdentifier(source, '__pnextRootParams')
  const declarations: string[] = []
  let importedProxy = false

  const rewritten = source.replace(IMPORT_RE, (_statement, clause: string) => {
    const bindings = parseBindings(clause)
    if (bindings.length === 0) return ''
    importedProxy = true
    for (const { imported, local } of bindings) {
      declarations.push(`const ${local} = ${proxyName}[${JSON.stringify(imported)}];`)
    }
    return ''
  })

  if (!importedProxy) return source
  return [
    `import ${proxyName} from ${JSON.stringify('next/root-params')};`,
    ...declarations,
    rewritten,
  ].join('\n')
}
