'use client'

import { compact } from '../format'
import type { WorkspaceWidget } from '../types'
import { tone23 } from 'fixture-ui-kit'

export default function Widget022({ widget }: { widget: WorkspaceWidget }) {
  return (
    <article className="workspace-widget" data-tone={tone23(widget.tone)}>
      <span>{widget.label}</span>
      <strong>{compact(widget.value)}</strong>
      <small>
        {widget.delta >= 0 ? '+' : ''}
        {widget.delta}% this week
      </small>
    </article>
  )
}
