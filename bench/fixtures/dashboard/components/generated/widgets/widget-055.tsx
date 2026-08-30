'use client'

import { compact } from '../format'
import type { WorkspaceWidget } from '../types'
import { tone24 } from 'fixture-ui-kit'

export default function Widget055({ widget }: { widget: WorkspaceWidget }) {
  return (
    <article className="workspace-widget" data-tone={tone24(widget.tone)}>
      <span>{widget.label}</span>
      <strong>{compact(widget.value)}</strong>
      <small>
        {widget.delta >= 0 ? '+' : ''}
        {widget.delta}% this week
      </small>
    </article>
  )
}
