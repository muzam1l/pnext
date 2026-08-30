/** @jsxImportSource preact */
import { Fragment, type ComponentChildren } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

export interface ProfilerProps {
  id: string
  children?: ComponentChildren
  onRender?: (
    id: string,
    phase: 'mount' | 'update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ) => void
}

export function Profiler({ id, children, onRender }: ProfilerProps) {
  const phase = useRef<'mount' | 'update'>('mount')
  useLayoutEffect(() => {
    const now = typeof performance === 'undefined' ? 0 : performance.now()
    onRender?.(id, phase.current, 0, 0, now, now)
    phase.current = 'update'
  })
  return <Fragment>{children}</Fragment>
}
