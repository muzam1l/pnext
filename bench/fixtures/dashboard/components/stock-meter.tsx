import ProgressBar from './progress-bar'

export default function StockMeter({
  onHand,
  reserved,
  reorderAt,
}: {
  onHand: number
  reserved: number
  reorderAt: number
}) {
  const available = onHand - reserved
  return (
    <div className="meter">
      <span className={available < reorderAt ? 'delta down' : 'delta up'}>
        {available} available of {onHand}
      </span>
      <ProgressBar value={available} max={Math.max(onHand, 1)} />
      <span className="muted">Reorder at {reorderAt}</span>
    </div>
  )
}
