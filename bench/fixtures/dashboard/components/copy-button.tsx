'use client'

import { useState } from 'react'

export default function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => {
        navigator.clipboard?.writeText(value)
        setCopied(true)
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
