export default async function Home() {
  return (
    <div class="hero">
      <div>
        <h1>Hello, world.</h1>
        <p class="lede">Your app is up and running.</p>
        <a class="button-link" href="https://www.pnext.dev/docs" target="_blank" rel="noopener">
          Read the docs
        </a>
      </div>
      <nav class="panel">
        <a href="/server">
          <span>
            <span class="path">/server</span>
            <span class="desc">Server component, rendered per request</span>
          </span>
          <span class="arrow">→</span>
        </a>
        <a href="/client">
          <span>
            <span class="path">/client</span>
            <span class="desc">Client component, interactive in the browser</span>
          </span>
          <span class="arrow">→</span>
        </a>
      </nav>
    </div>
  )
}
