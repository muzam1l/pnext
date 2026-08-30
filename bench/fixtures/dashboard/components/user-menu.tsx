'use client'

import { useState } from 'react'
import Avatar from './avatar'

export default function UserMenu({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu">
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(!open)}>
        <Avatar name={name} />
        {name}
      </button>
      {open ? (
        <ul className="menu-list">
          <li>
            <a href="/settings">Profile</a>
          </li>
          <li>
            <a href="/settings/billing">Billing</a>
          </li>
          <li>
            <a href="/sign-in">Sign out</a>
          </li>
        </ul>
      ) : null}
    </div>
  )
}
