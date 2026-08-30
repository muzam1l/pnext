'use client'

export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <section className="card">
      <h2>Invoices are unavailable</h2>
      <p className="muted">{error.message}</p>
      <button type="button" className="btn btn-primary" onClick={reset}>
        Reload
      </button>
    </section>
  )
}
