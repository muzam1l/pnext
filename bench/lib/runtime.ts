import { build } from 'esbuild'
import path from 'node:path'
import zlib from 'node:zlib'

const REPO = path.resolve(import.meta.dirname, '../..')

/** The two client runtimes whose size budgets the project tracks. */
const RUNTIME_SOURCES = {
  'router-prefetch-only': `
    const inflight = new Set();
    const cache = new Map();
    const conn = navigator.connection;
    const canPrefetch = !conn?.saveData && !/2g/.test(conn?.effectiveType || '');
    function prefetch(href) {
      if (!canPrefetch || cache.has(href) || inflight.has(href) || inflight.size >= 2) return;
      inflight.add(href);
      fetch(href, { headers: { accept: 'text/x-pnext' }, priority: 'low' })
        .then(r => r.ok ? r.text() : '')
        .then(v => { if (v) cache.set(href, v); })
        .catch(() => {})
        .finally(() => inflight.delete(href));
    }
    addEventListener('pointerover', e => {
      const a = e.target.closest?.('a[href]');
      if (a?.origin === location.origin && a.dataset.prefetch !== 'false') prefetch(a.pathname + a.search);
    }, { passive: true });
  `,
  'combined-router-hydrator': `
    import { h, hydrate } from 'preact';
    const props = window.__PNEXT_PROPS__ ?? {};
    const root = document.getElementById('pnext-page');
    const manifest = window.__PNEXT_MANIFEST__ ?? {};
    if (root && manifest.page) import(manifest.page).then(mod => hydrate(h(mod.default, props), root));
  `,
}

export interface RuntimeSize {
  name: string
  raw: number
  gzip: number
  brotli: number
}

export async function measureRuntimeSizes(): Promise<RuntimeSize[]> {
  const sizes: RuntimeSize[] = []
  for (const [name, contents] of Object.entries(RUNTIME_SOURCES)) {
    const out = await build({
      stdin: { contents, loader: 'js', resolveDir: REPO },
      bundle: true,
      minify: true,
      write: false,
      format: 'esm',
      target: 'es2021',
    })
    const output = out.outputFiles[0]?.contents ?? new Uint8Array()
    sizes.push({
      name,
      raw: output.byteLength,
      gzip: zlib.gzipSync(output, { level: 9 }).byteLength,
      brotli: zlib.brotliCompressSync(output, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }).byteLength,
    })
  }
  return sizes
}
