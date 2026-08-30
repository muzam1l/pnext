// next.config images validation (COMPAT). Mirrors Next's zod config-schema messages for the `images`
// block (and the assetPrefix URL check) - the image-optimizer e2e suite asserts these exact strings in
// the build output of an invalid config. Only the rules Next enforces are checked.

import fs from 'node:fs'
import path from 'node:path'

const LOADERS = ['default', 'imgix', 'cloudinary', 'akamai', 'custom'] as const
const FORMATS = ['image/avif', 'image/webp'] as const
const DISPOSITIONS = ['inline', 'attachment'] as const
const REMOTE_PATTERN_KEYS = new Set(['protocol', 'hostname', 'port', 'pathname', 'search'])
const LOCAL_PATTERN_KEYS = new Set(['pathname', 'search'])

function hasDefaultExport(file: string): boolean {
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  return /\bexport\s+default\b/.test(source) || /\bmodule\.exports\s*=/.test(source)
}

function received(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function quotedUnion(options: readonly string[]): string {
  return options.map(option => `'${option}'`).join(' | ')
}

/**
 * Validate the images/assetPrefix portions of a next.config object. Returns
 * Next's exact error strings (empty array when valid).
 */
export function collectImagesConfigErrors(config: Record<string, unknown>, root: string): string[] {
  const errors: string[] = []

  const assetPrefix = config.assetPrefix
  if (typeof assetPrefix === 'string' && assetPrefix !== '' && !assetPrefix.startsWith('/')) {
    try {
      new URL(assetPrefix)
    } catch {
      // Bun's URL error text differs from Node's; emit Node's exact phrasing.
      errors.push('Invalid assetPrefix provided. Original error: TypeError: Invalid URL')
    }
  }

  const images = config.images
  if (images === undefined || images === null) return errors
  if (typeof images !== 'object' || Array.isArray(images)) {
    errors.push(`Expected object, received ${received(images)} at "images"`)
    return errors
  }
  const img = images as Record<string, unknown>

  validateSizeArray(errors, img.deviceSizes, 'images.deviceSizes')
  validateSizeArray(errors, img.imageSizes, 'images.imageSizes')

  if (img.domains !== undefined) {
    if (!Array.isArray(img.domains)) {
      errors.push(`Expected array, received ${received(img.domains)} at "images.domains"`)
    } else if (img.domains.length > 50) {
      errors.push('Array must contain at most 50 element(s) at "images.domains"')
    }
  }

  if (img.qualities !== undefined) {
    if (!Array.isArray(img.qualities)) {
      errors.push(`Expected array, received ${received(img.qualities)} at "images.qualities"`)
    } else {
      if (img.qualities.length < 1) {
        errors.push('Array must contain at least 1 element(s) at "images.qualities"')
      }
      if (img.qualities.length > 20) {
        errors.push('Array must contain at most 20 element(s) at "images.qualities"')
      }
      img.qualities.forEach((quality, index) => {
        if (typeof quality !== 'number') {
          errors.push(
            `Expected number, received ${received(quality)} at "images.qualities[${index}]"`,
          )
        } else if (!Number.isInteger(quality)) {
          errors.push(`Expected integer, received float at "images.qualities[${index}]"`)
        } else if (quality < 1) {
          errors.push(`Number must be greater than or equal to 1 at "images.qualities[${index}]"`)
        } else if (quality > 100) {
          errors.push(`Number must be less than or equal to 100 at "images.qualities[${index}]"`)
        }
      })
    }
  }

  if (img.localPatterns !== undefined) {
    if (!Array.isArray(img.localPatterns)) {
      errors.push(
        `Expected array, received ${received(img.localPatterns)} at "images.localPatterns"`,
      )
    } else {
      if (img.localPatterns.length > 25) {
        errors.push('Array must contain at most 25 element(s) at "images.localPatterns"')
      }
      img.localPatterns.forEach((pattern, index) => {
        if (!pattern || typeof pattern !== 'object') return
        const unknown = Object.keys(pattern as Record<string, unknown>).filter(
          key => !LOCAL_PATTERN_KEYS.has(key),
        )
        if (unknown.length > 0) {
          errors.push(
            `Unrecognized key(s) in object: ${unknown.map(key => `'${key}'`).join(', ')} at "images.localPatterns[${index}]"`,
          )
        }
      })
    }
  }

  if (img.remotePatterns !== undefined) {
    if (!Array.isArray(img.remotePatterns)) {
      errors.push(
        `Expected array, received ${received(img.remotePatterns)} at "images.remotePatterns"`,
      )
    } else {
      if (img.remotePatterns.length > 50) {
        errors.push('Array must contain at most 50 element(s) at "images.remotePatterns"')
      }
      img.remotePatterns.forEach((pattern, index) => {
        if (pattern instanceof URL) {
          const protocol = pattern.protocol.replace(/:$/, '')
          if (protocol !== 'http' && protocol !== 'https') {
            errors.push(
              `Specified images.remotePatterns must have protocol "http" or "https" received "${protocol}"`,
            )
          }
          return
        }
        if (!pattern || typeof pattern !== 'object') {
          errors.push(
            `Expected object, received ${received(pattern)} at "images.remotePatterns[${index}]"`,
          )
          return
        }
        const obj = pattern as Record<string, unknown>
        const unknown = Object.keys(obj).filter(key => !REMOTE_PATTERN_KEYS.has(key))
        if (unknown.length > 0) {
          errors.push(
            `Unrecognized key(s) in object: ${unknown.map(key => `'${key}'`).join(', ')} at "images.remotePatterns[${index}]"`,
          )
        }
        if (typeof obj.hostname !== 'string') {
          errors.push(`"images.remotePatterns[${index}].hostname" is missing, expected string`)
        }
      })
    }
  }

  if (img.loader !== undefined) {
    if (typeof img.loader !== 'string' || !LOADERS.includes(img.loader as never)) {
      errors.push(
        `Expected ${quotedUnion(LOADERS)}, received '${received(img.loader) === 'string' ? (img.loader as string) : received(img.loader)}' at "images.loader"`,
      )
    } else if (img.loader !== 'default' && img.loader !== 'custom') {
      const loader = img.loader
      if (typeof img.path !== 'string' || img.path === '' || img.path === '/_next/image') {
        errors.push(
          `Specified images.loader property (${loader}) also requires images.path property to be assigned to a URL prefix.`,
        )
      }
      if (typeof img.loaderFile === 'string' && img.loaderFile !== '') {
        errors.push(
          `Specified images.loader property (${loader}) cannot be used with images.loaderFile property. Please set images.loader to "custom".`,
        )
      }
    }
  }

  if (typeof img.loaderFile === 'string' && img.loaderFile !== '') {
    // A leading-'/' loaderFile is project-root-relative in Next, not an
    // absolute filesystem path — resolve it against the config root.
    const absolute = img.loaderFile.startsWith('/')
      ? path.join(root, img.loaderFile)
      : path.resolve(root, img.loaderFile)
    if (!fs.existsSync(absolute)) {
      errors.push(`Specified images.loaderFile does not exist at "${absolute}".`)
    } else if (!hasDefaultExport(absolute)) {
      errors.push(
        'images.loaderFile detected but the file is missing default export.\n' +
          'Read more: https://nextjs.org/docs/messages/invalid-images-config',
      )
    }
  }

  if (img.formats !== undefined) {
    if (!Array.isArray(img.formats)) {
      errors.push(`Expected array, received ${received(img.formats)} at "images.formats"`)
    } else {
      img.formats.forEach((format, index) => {
        if (!FORMATS.includes(format as never)) {
          errors.push(
            `Expected ${quotedUnion(FORMATS)}, received '${String(format)}' at "images.formats[${index}]"`,
          )
        }
      })
    }
  }

  if (
    img.contentDispositionType !== undefined &&
    !DISPOSITIONS.includes(img.contentDispositionType as never)
  ) {
    errors.push(
      `Expected ${quotedUnion(DISPOSITIONS)}, received '${typeof img.contentDispositionType === 'string' ? img.contentDispositionType : received(img.contentDispositionType)}' at "images.contentDispositionType"`,
    )
  }

  if (img.contentSecurityPolicy !== undefined && typeof img.contentSecurityPolicy !== 'string') {
    errors.push(
      `Expected string, received ${received(img.contentSecurityPolicy)} at "images.contentSecurityPolicy"`,
    )
  }

  if (img.minimumCacheTTL !== undefined) {
    if (typeof img.minimumCacheTTL !== 'number') {
      errors.push(
        `Expected number, received ${received(img.minimumCacheTTL)} at "images.minimumCacheTTL"`,
      )
    } else if (img.minimumCacheTTL < 0) {
      errors.push('Number must be greater than or equal to 0 at "images.minimumCacheTTL"')
    }
  }

  for (const key of ['dangerouslyAllowSVG', 'unoptimized', 'disableStaticImages'] as const) {
    if (img[key] !== undefined && typeof img[key] !== 'boolean') {
      errors.push(`Expected boolean, received ${received(img[key])} at "images.${key}"`)
    }
  }

  return errors
}

function validateSizeArray(errors: string[], value: unknown, label: string): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`Expected array, received ${received(value)} at "${label}"`)
    return
  }
  if (value.length > 25) {
    errors.push(`Array must contain at most 25 element(s) at "${label}"`)
  }
  value.forEach((size, index) => {
    if (typeof size !== 'number') {
      errors.push(`Expected number, received ${received(size)} at "${label}[${index}]"`)
    } else if (size < 1) {
      errors.push(`Number must be greater than or equal to 1 at "${label}[${index}]"`)
    } else if (size > 10000) {
      errors.push(`Number must be less than or equal to 10000 at "${label}[${index}]"`)
    }
  })
}
