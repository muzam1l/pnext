'use client'

import { useState } from 'preact/hooks'

export default function ClientPage() {
  const [text, setText] = useState('')
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return (
    <div class="page">
      <span class="chip">client component</span>
      <h1>Running in the browser</h1>
      <input
        class="field"
        placeholder="Type something…"
        value={text}
        onInput={e => setText(e.currentTarget.value)}
      />
      <dl class="panel">
        <div>
          <dt>Characters</dt>
          <dd>{text.length}</dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{words}</dd>
        </div>
      </dl>
    </div>
  )
}
