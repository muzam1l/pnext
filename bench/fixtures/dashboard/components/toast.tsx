'use client'

import { useState } from 'react'

export default function Toast({ label }: { label: string }) {
  const [message, setMessage] = useState('')
  return (
    <div className="toast-host">
      <button type="button" className="btn btn-ghost" onClick={() => setMessage(`${label} — done`)}>
        {label}
      </button>
      {message ? (
        <output className="toast" onClick={() => setMessage('')}>
          {message}
        </output>
      ) : null}
    </div>
  )
}
