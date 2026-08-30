import { createHash } from 'node:crypto'

import { isIdentifier, uniqueIdentifier } from '../../utils/code'

export function rewriteStyledJsxSource(source: string, file: string): string {
  if (!source.includes('<style') || !/\bjsx\b/.test(source)) return source

  let next = source
  for (const match of source.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]styled-jsx\/css['"]\s*;?/g,
  )) {
    const [statement, binding] = match
    if (!statement || !binding || !isIdentifier(binding)) continue
    next = next.replace(statement, '')
    next = next.replace(
      new RegExp(`\\b${binding}\`((?:\\\\.|[^\`])*)\``, 'g'),
      (_statement, css: string) => `\`${minifyStaticCss(css)}\``,
    )
  }

  const component = uniqueIdentifier(next, '__PNextStyledJsx')
  let index = 0
  next = next.replace(
    /<style\s+(?:global\s+)?jsx\s*>\s*\{([\s\S]*?)\}\s*<\/style>/g,
    (_statement, css: string) => {
      const id = createHash('sha256').update(`${file}:${index++}`).digest('hex').slice(0, 12)
      return `<${component} id=${JSON.stringify(id)}>{${minifyTemplate(css)}}</${component}>`
    },
  )
  if (index === 0) return source

  const directives = /^(?:\s*['"][^'"]+['"];?\s*)*/.exec(next)?.[0] ?? ''
  return `${directives}import { style as ${component} } from 'styled-jsx';\n${next.slice(directives.length)}`
}

function minifyTemplate(expression: string): string {
  const match = /^\s*`([\s\S]*)`\s*$/.exec(expression)
  if (!match?.[1] || match[1].includes('${')) return expression
  return `\`${minifyStaticCss(match[1])}\``
}

function minifyStaticCss(css: string): string {
  if (css.includes('${')) return css
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .trim()
}
