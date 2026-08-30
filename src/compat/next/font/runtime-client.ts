/**
 * Client-bundle variant of the next/font runtime.
 *
 * A `'use client'` component that calls `next/font/google` or `next/font/local` needs ONLY the
 * pre-hashed className/variable/style off the font object - the actual CSS and font files are emitted
 * and served by the SERVER runtime and already present in the SSR'd HTML. So this entry imports NOTHING
 * from `node:*`, registers NO response finalizers at module scope, and derives className/variable/style
 * from the SAME client-safe shared logic the server uses, so the hashes match exactly.
 *
 * rewriteNextFontSource targets this file for CLIENT builds and runtime.ts for SERVER builds.
 */

import {
  googleFontNaming,
  localFontNaming,
  fontStyle,
  type GoogleFontOptions,
  type LocalFontOptions,
  type NextFontWithVariable,
} from './shared'

export type {
  FontDisplay,
  GoogleFontOptions,
  LocalFontOptions,
  LocalFontSource,
  NextFont,
  NextFontWithVariable,
} from './shared'

function fontObject(naming: {
  className: string
  variable: string
  hasVariable: boolean
  style: NextFontWithVariable['style']
}): NextFontWithVariable {
  // Plain data object: no registration side effects (the server already emitted
  // the CSS/assets). Client code reads className/variable/style off this. The
  // `variable` key is omitted when the loader call passed no `variable` option,
  // matching Next (a `toEqual` on the font object would otherwise see an extra
  // key).
  const font: NextFontWithVariable = {
    className: naming.className,
    style: naming.style,
  } as NextFontWithVariable
  if (naming.hasVariable) font.variable = naming.variable
  return font
}

export function googleFont(family: string) {
  return (options: GoogleFontOptions = {}): NextFontWithVariable =>
    fontObject(googleFontNaming(family, options))
}

export interface LocalFontLoader {
  (options: LocalFontOptions): NextFontWithVariable
  withFile: typeof localFontWithFile
}

export function localFontWithFile(callerFile: string | undefined, family?: string) {
  return (options: LocalFontOptions): NextFontWithVariable =>
    fontObject({
      ...localFontNaming(callerFile, options),
      ...(family
        ? { fontFamily: family, style: fontStyle(family, options, options.fallback ?? []) }
        : {}),
    })
}

export const localFont: LocalFontLoader = Object.assign(
  (options: LocalFontOptions) => localFontWithFile(undefined)(options),
  { withFile: localFontWithFile },
)
