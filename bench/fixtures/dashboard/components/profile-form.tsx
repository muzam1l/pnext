'use client'

import { useState } from 'react'
import { saveProfile } from '../lib/actions'

const text = (value: FormDataEntryValue | null) => (typeof value === 'string' ? value : '')

export default function ProfileForm({ name, email }: { name: string; email: string }) {
  const [status, setStatus] = useState('')
  return (
    <form
      className="form"
      onSubmit={async event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const result = await saveProfile({
          name: text(data.get('name')),
          email: text(data.get('email')),
        })
        setStatus(result.ok ? 'Saved' : 'Failed')
      }}
    >
      <label>
        Name
        <input className="input" name="name" defaultValue={name} />
      </label>
      <label>
        Email
        <input className="input" name="email" defaultValue={email} />
      </label>
      <button className="btn btn-primary" type="submit">
        Save profile
      </button>
      <span className="form-status">{status}</span>
    </form>
  )
}
