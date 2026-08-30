export default function StatusDot({ ok }: { ok: boolean }) {
  return <span className={ok ? 'dot dot-ok' : 'dot dot-bad'} aria-hidden="true" />
}
