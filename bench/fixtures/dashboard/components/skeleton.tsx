export default function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span
          key={index}
          className="skeleton-row"
          style={{ width: `${100 - (index % 4) * 12}%` }}
        />
      ))}
    </div>
  )
}
