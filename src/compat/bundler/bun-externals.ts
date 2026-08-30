import { uniqueIdentifier } from '../../utils/code'

// A quoted `'bun'`/`'bun:x'` specifier anywhere in the source. Deliberately not
// the module record's edges: a route handler looping
// `require(name)` over a table of module names has NO static edge, and Next
// still externalizes those. Matching the quoted specifier keeps that reach while
// staying far tighter than the old bare-word `bun` regex.
const QUOTED_BUN_SPECIFIER = /(['"])bun(?::[^'"]+)?\1/

/**
 * Guard `bun`/`bun:*` builtins behind a runtime throw so a module importing one can still be compiled
 * for a non-Bun target. The call-site rewrite is textual - the guard has to reach non-literal
 * require/import calls too, which no record can name.
 */
export function rewriteBunBuiltinExternals(source: string, _file = 'module.tsx'): string {
  if (!source.includes('bun')) return source
  if (!QUOTED_BUN_SPECIFIER.test(source)) return source

  const requireName = uniqueIdentifier(source, '__pnext_require_external')
  const importName = uniqueIdentifier(source, '__pnext_import_external', requireName)
  const literalRequires: string[] = []
  let next = source.replace(
    /\brequire\s*\(\s*(['"])(bun(?::[^'"]+)?)\1\s*\)/g,
    (_match, _quote: string, specifier: string) => {
      literalRequires.push(specifier)
      return `__pnext_bun_external_${literalRequires.length - 1}__`
    },
  )
  next = next.replace(/\brequire\s*\(/g, `${requireName}(`)
  next = next.replace(/__pnext_bun_external_(\d+)__/g, (_match, index: string) => {
    const specifier = literalRequires[Number(index)]
    return `${requireName}(${JSON.stringify(specifier)}, () => require(${JSON.stringify(specifier)}))`
  })
  next = next.replace(/\bimport\s*\(/g, `${importName}(`)

  const directive = /^(?:\s*['"][^'"]+['"];?\s*)*/.exec(next)?.[0] ?? ''
  const helpers = [
    `const ${requireName} = (specifier, load) => {`,
    `  if (specifier === 'bun' || specifier.startsWith('bun:')) {`,
    "    throw new Error(`Cannot find module '${specifier}'`);",
    '  }',
    '  return load ? load() : require(specifier);',
    '};',
    `const ${importName} = (specifier) => {`,
    `  if (specifier === 'bun' || specifier.startsWith('bun:')) {`,
    "    return Promise.reject(new Error(`Cannot find module '${specifier}'`));",
    '  }',
    '  return import(specifier);',
    '};',
    '',
  ].join('\n')
  return `${directive}${helpers}${next.slice(directive.length)}`
}
