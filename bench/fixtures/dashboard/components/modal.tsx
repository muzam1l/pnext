'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

export default function Modal({
  trigger,
  title,
  children,
}: {
  trigger: string
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        {trigger}
      </button>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-label={title}
            onClick={event => event.stopPropagation()}
          >
            <header className="modal-head">
              <h3>{title}</h3>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>
            {children}
          </div>
        </div>
      ) : null}
    </>
  )
}
