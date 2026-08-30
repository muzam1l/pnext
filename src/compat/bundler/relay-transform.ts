// next.config `compiler.relay` (COMPAT).
//
// Next runs the Relay SWC transform, which replaces every graphql-tagged template with a reference to
// the artifact relay-compiler generated for that operation. Without the transform the tag survives into
// the bundle and relay-runtime's `graphql()` throws its "Unexpected invocation at runtime" invariant on
// the first render.
//
// pnext has no SWC, so this is a plain source transform: for each tagged template it reads the
// operation/fragment name out of the GraphQL body, resolves the matching artifact on disk, hoists an
// `import * as <binding>` and substitutes the binding for the tag. Passing the module namespace rather
// than the default export is exactly what the babel/SWC transforms emit - relay-runtime's `getNode()`
// unwraps `node.default` for ES-module artifacts and takes the object as-is for the CommonJS ones.
//
// Everything is resolved relative to `process.cwd()`, matching the SWC transform's root. That is what
// makes the multi-project fixture work: each sub-project is built with its own cwd.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { withSniff, type ServerSourceTransform } from '../../extensions'
import type { RelayCompilerConfig } from './config'

/** The artifact extension relay-compiler emits for each `language` setting. */
function artifactExtensions(language: RelayCompilerConfig['language']): string[] {
  // Try the configured language's extension first, then the other one: a
  // project can point `artifactDirectory` at output generated with a different
  // `language` than next.config declares (the multi-project fixture reads its
  // `language` from a sibling project's relay config).
  return language === 'typescript' ? ['.ts', '.js'] : ['.js', '.ts']
}

/** `graphql`-tagged templates. GraphQL has no backticks, so a lazy scan is exact. */
function relayTagPattern(): RegExp {
  return /(?<![\w$.])graphql\s*`([\s\S]*?)`/g
}

const OPERATION_NAME = /\b(?:query|mutation|subscription|fragment)\s+([A-Za-z_][\w]*)/

function isUnder(dir: string, file: string): boolean {
  const relative = path.relative(dir, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// Insert hoisted imports after any leading directive prologue ('use client' /
// 'use server' / 'use strict') and optional shebang, so a client module's
// `'use client'` stays the first statement.
function injectAfterDirectives(source: string, injection: string): string {
  const prologue =
    /^(\uFEFF?(?:#![^\n]*\n)?(?:[ \t]*(['"])use [\w-]+\2[ \t]*;?[ \t]*(?:\r?\n|$))*)/.exec(source)
  const index = prologue ? prologue[0].length : 0
  return `${source.slice(0, index)}${injection}\n${source.slice(index)}`
}

/**
 * Build a source transform applying `compiler.relay`. Returns a no-op transform
 * when nothing is configured so pure-core apps pay nothing.
 */
export function createRelayTransform(
  relay: RelayCompilerConfig | undefined,
): ServerSourceTransform {
  if (!relay) return withSniff([], source => source)

  const cwd = path.resolve(process.cwd())
  const srcDir = path.resolve(cwd, relay.src)
  const artifactDir = relay.artifactDirectory
    ? path.resolve(cwd, relay.artifactDirectory)
    : undefined
  const extensions = artifactExtensions(relay.language)
  const resolved = new Map<string, string | undefined>()

  /** The on-disk artifact for one operation name, or undefined when absent. */
  function artifactFor(fileDir: string, name: string): string | undefined {
    // Without `artifactDirectory`, relay-compiler writes `__generated__` next
    // to the source file.
    const directory = artifactDir ?? path.join(fileDir, '__generated__')
    const key = `${directory}\0${name}`
    if (resolved.has(key)) return resolved.get(key)
    let found: string | undefined
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}.graphql${extension}`)
      if (existsSync(candidate)) {
        found = candidate
        break
      }
    }
    resolved.set(key, found)
    return found
  }

  return withSniff(['graphql'], (source, file) => {
    if (!source.includes('graphql`') && !/graphql\s*`/.test(source)) return source
    const absolute = path.resolve(file)
    // Next scopes the transform to `src`. Files outside the build cwd entirely
    // (materialized copies) are not covered by that check, so only skip a file
    // that lives under the cwd but outside the configured source root.
    if (isUnder(cwd, absolute) && !isUnder(srcDir, absolute)) return source

    const bindings = new Map<string, string>()
    const replaced = source.replace(relayTagPattern(), (match, body: string) => {
      const name = OPERATION_NAME.exec(body)?.[1]
      if (!name) return match
      const artifact = artifactFor(path.dirname(absolute), name)
      if (!artifact) return match
      let binding = bindings.get(artifact)
      if (!binding) {
        binding = `__pnext_relay_${bindings.size}`
        bindings.set(artifact, binding)
      }
      return binding
    })
    if (bindings.size === 0) return source

    const imports = [...bindings]
      .map(([artifact, binding]) => `import * as ${binding} from ${JSON.stringify(artifact)};`)
      .join('\n')
    return injectAfterDirectives(replaced, imports)
  })
}
