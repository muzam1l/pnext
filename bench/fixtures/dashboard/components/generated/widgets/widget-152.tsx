'use client'

import { compact } from '../format'
import type { WorkspaceWidget } from '../types'
import { tone25 } from 'fixture-ui-kit'

export default function Widget152({ widget }: { widget: WorkspaceWidget }) {
  return (
    <article className="workspace-widget" data-tone={tone25(widget.tone)}>
      <span>{widget.label}</span>
      <strong>{compact(widget.value)}</strong>
      <small>
        {widget.delta >= 0 ? '+' : ''}
        {widget.delta}% this week
      </small>
    </article>
  )
}
