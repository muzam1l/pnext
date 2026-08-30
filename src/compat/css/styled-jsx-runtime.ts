// styled-jsx compat runtime, aliased in place of the styled-jsx package (the css/styled-jsx.ts source
// transform rewrites <style jsx> blocks to import `style` from here, so apps never install styled-jsx).
//
// Two modes:
//   - No <StyleRegistry> mounted: `style` renders an inline <style> tag right where the block appeared.
//   - A <StyleRegistry registry={...}> ancestor (the app-registry pattern): `style` registers its CSS on
//     the registry and renders nothing; the app flushes `registry.styles()` through
//     useServerInsertedHTML so the rules land in the streamed document head. On the client the registry
//     mirrors new rules into document.head imperatively, matching styled-jsx's client runtime.
import { createContext, h, type ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'

interface StyleProps {
  id: string
  children?: ComponentChildren
}

export class PNextStyleRegistry {
  private rules = new Map<string, string>()

  add(id: string, css: string): void {
    if (this.rules.has(id)) return
    this.rules.set(id, css)
    if (typeof document !== 'undefined') {
      const domId = `__jsx-${id}`
      if (!document.getElementById(domId)) {
        const element = document.createElement('style')
        element.id = domId
        element.textContent = css
        document.head.appendChild(element)
      }
    }
  }

  /** The collected <style> elements, styled-jsx's `registry.styles()` shape. */
  styles() {
    return [...this.rules.entries()].map(([id, css]) =>
      h('style', { id: `__jsx-${id}`, key: `__jsx-${id}` }, css),
    )
  }

  flush(): void {
    this.rules.clear()
  }
}

const StyleRegistryContext = createContext<PNextStyleRegistry | undefined>(undefined)

export function createStyleRegistry(): PNextStyleRegistry {
  return new PNextStyleRegistry()
}

export function StyleRegistry({
  registry,
  children,
}: {
  registry?: PNextStyleRegistry
  children?: ComponentChildren
}) {
  return h(StyleRegistryContext.Provider, { value: registry ?? createStyleRegistry() }, children)
}

export function useStyleRegistry(): PNextStyleRegistry | undefined {
  return useContext(StyleRegistryContext)
}

export function style({ id, children }: StyleProps) {
  const registry = useContext(StyleRegistryContext)
  if (registry) {
    registry.add(id, childrenToCss(children))
    return null
  }
  return h('style', { id: `__jsx-${id}` }, children)
}

function childrenToCss(children: ComponentChildren): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToCss).join('')
  return ''
}
