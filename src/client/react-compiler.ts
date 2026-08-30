import {
  transform,
  transformSync,
  type TransformOptions,
  type TransformResult,
} from 'oxc-transform'
import type { getCompatModeExtensions } from '../extensions'

type ReactCompilerOptions = NonNullable<
  ReturnType<ReturnType<typeof getCompatModeExtensions>['reactCompilerOptions']>
>

// oxc-transform runs the React Compiler (Rust port) plus TypeScript stripping
// in a single pass, replacing the @babel/core round-trip. JSX is left intact
// (`jsx: 'preserve'`) so esbuild stays the single source of truth for the
// preact JSX transform downstream.
function compilerOptions(options: ReactCompilerOptions): TransformOptions {
  return {
    jsx: 'preserve',
    sourcemap: false,
    reactCompiler: {
      panicThreshold: 'critical_errors',
      target: options.target as '17' | '18' | '19',
    },
  }
}

/**
 * The React Compiler pass. It has no esbuild plugin of its own: the client-source loader owns every
 * first-party source file and calls this as the last step of that file's single rewrite pass, so
 * the compiler applies exactly once regardless of plugin registration order. oxc strips TS types as
 * part of the pass, so no separate type-import cleanup is needed.
 *
 * `transform`, not `transformSync`: the async binding runs on oxc's Rust threadpool, so esbuild's
 * concurrent onLoad callbacks compile the whole route set in parallel instead of queueing on the
 * JS thread.
 */
export async function transformReactCompiler(
  source: string,
  file: string,
  options: ReactCompilerOptions,
) {
  return reactCompilerResult(await transform(file, source, compilerOptions(options)), source, file)
}

/** Same pass, for the few callers that cannot await (kept in lock-step above). */
export function transformReactCompilerSync(
  source: string,
  file: string,
  options: ReactCompilerOptions,
) {
  return reactCompilerResult(transformSync(file, source, compilerOptions(options)), source, file)
}

function reactCompilerResult(result: TransformResult, source: string, file: string) {
  // When the compiler cannot compile a function (rule-of-React violation, unsupported library, a
  // construct the Rust port does not yet handle) it reports a diagnostic. If the whole file trips one,
  // oxc emits no code at all - unlike Babel, which skips just that function - so fall back to the
  // untransformed source and let esbuild strip types and handle JSX; the file ships un-memoized.
  // `panicThreshold` does not change this: every value still yields empty output on a hard bailout.
  if (!result.code) {
    // Only genuine transform failures (not React Compiler bailouts) are worth
    // surfacing; esbuild re-parses the fallback source and would flag the rest.
    const failures = result.errors.filter(error => !error.message.startsWith('[ReactCompiler]'))
    if (failures.length > 0) {
      console.error(
        `React Compiler (oxc) failed for ${file}:\n${failures.map(error => error.message).join('\n')}`,
      )
    }
    return source
  }

  return result.code
}

export function stripPureTypeImports(source: string) {
  return source
    .replace(/^\s*import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(
      /^\s*import\s+\{([^}]*)\}\s+from\s+(['"][^'"]+['"])\s*;?\s*$/gm,
      (_match, clause: string, specifier: string) => {
        const valueSpecifiers = clause
          .split(',')
          .map(item => item.trim())
          .filter(Boolean)
          .filter(item => !item.startsWith('type '))

        return valueSpecifiers.length > 0
          ? `import { ${valueSpecifiers.join(', ')} } from ${specifier};`
          : ''
      },
    )
}

/** JSX always; a plain .ts/.js only when it looks like it holds a component. */
export function shouldReactCompile(source: string, file: string) {
  if (/\.[cm]?[jt]sx$/.test(file)) return true
  return /\b(?:use[A-Z][\w$]*|createElement|memo|forwardRef)\b/.test(source)
}
