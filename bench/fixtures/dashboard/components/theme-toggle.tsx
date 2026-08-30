'use client'

import { useState } from 'react'

export default function ThemeToggle() {
  const [dark, setDark] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => {
        setDark(!dark)
        document.documentElement.dataset.theme = dark ? 'light' : 'dark'
      }}
    >
      {dark ? 'Light' : 'Dark'} mode
    </button>
  )
}
