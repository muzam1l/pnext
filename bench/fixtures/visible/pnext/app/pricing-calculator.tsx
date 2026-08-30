'use client'

import { useState } from 'preact/hooks'
import { PLANS, type PlanId } from '../lib/content'

export default function PricingCalculator() {
  const [seats, setSeats] = useState(5)
  const [plan, setPlan] = useState<PlanId>('starter')
  const [yearly, setYearly] = useState(false)
  const monthly = seats * PLANS[plan]
  const total = yearly ? monthly * 10 : monthly

  return (
    <div className="card">
      <div className="stepper">
        <button onClick={() => setSeats(Math.max(1, seats - 1))}>−</button>
        <span>{seats} seats</span>
        <button onClick={() => setSeats(seats + 1)}>+</button>
      </div>
      <div className="stepper">
        {(Object.keys(PLANS) as PlanId[]).map(id => (
          <button key={id} aria-pressed={plan === id} onClick={() => setPlan(id)}>
            {id}
          </button>
        ))}
        <button aria-pressed={yearly} onClick={() => setYearly(!yearly)}>
          yearly
        </button>
      </div>
      <p className="total">
        ${total} / {yearly ? 'year' : 'month'}
      </p>
    </div>
  )
}
