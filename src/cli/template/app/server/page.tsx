export const metadata = {
  title: 'Server component',
}

export default async function ServerPage() {
  const renderedAt = new Date().toLocaleTimeString('en-US', { hour12: false })
  return (
    <div class="page">
      <span class="chip">server component</span>
      <h1>Rendered on the server</h1>
      <dl class="panel">
        <div>
          <dt>Rendered at</dt>
          <dd>{renderedAt}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>Bun {Bun.version}</dd>
        </div>
        <div>
          <dt>Client JS</dt>
          <dd>none</dd>
        </div>
      </dl>
    </div>
  )
}
