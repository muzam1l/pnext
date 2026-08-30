import type { ReactNode } from 'react'

export default function Button({
  children,
  variant = 'primary',
  type = 'button',
}: {
  children: ReactNode
  variant?: 'primary' | 'ghost'
  type?: 'button' | 'submit'
}) {
  return (
    <button className={`btn btn-${variant}`} type={type}>
      {children}
    </button>
  )
}
