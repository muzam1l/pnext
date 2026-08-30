'use client'

import { useState } from 'react'
import { inviteMember } from '../lib/actions'

const STEPS = ['Person', 'Access', 'Review']

export default function MultiStepForm({ roles }: { roles: string[] }) {
  const [step, setStep] = useState(0)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState(roles[0] ?? '')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('')

  return (
    <div className="wizard">
      <ol className="steps">
        {STEPS.map((name, index) => (
          <li key={name} className={index === step ? 'step active' : 'step'}>
            {index + 1}. {name}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <label>
          Email
          <input
            className="input"
            value={email}
            onInput={event => setEmail((event.target as HTMLInputElement).value)}
          />
        </label>
      ) : null}

      {step === 1 ? (
        <label>
          Role
          <select
            className="input"
            value={role}
            onInput={event => setRole((event.target as HTMLSelectElement).value)}
          >
            {roles.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {step === 2 ? (
        <label>
          Note
          <textarea
            className="input"
            value={message}
            onInput={event => setMessage((event.target as HTMLTextAreaElement).value)}
          />
        </label>
      ) : null}

      <div className="wizard-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
        >
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const result = await inviteMember({ email, role, message })
              setStatus(result.ok ? `Invited ${result.email}` : 'Enter a valid email')
            }}
          >
            Send invite
          </button>
        )}
        <span className="form-status">{status}</span>
      </div>
    </div>
  )
}
