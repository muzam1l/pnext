// Dev-only loud page for errors that originate inside pnext itself. App errors keep the normal
// error/global-error documents; a framework failure instead gets the full trace and a prefilled
// GitHub issue, because "This page couldn't load" hides exactly the information a bug report needs.

import { pnextVersionRange } from '../utils/fs'
import { escapeHtml } from '../utils/html'

const ISSUES_URL = 'https://github.com/muzam1l/pnext/issues/new'
// Keep the prefilled issue URL well under browser/GitHub limits.
const MAX_ISSUE_BODY = 5_000

const FRAME_PATH = /\(?((?:file:\/\/)?\/[^\s):]+)(?::\d+){0,2}\)?/

/**
 * A located stack frame is "pnext" when it resolves inside pnext's own source (a workspace
 * checkout's `pnext/src/` or an installed `@wular/pnext/`). The error classifies as internal when
 * every located frame is pnext — one app or foreign-package frame means app code was on the throw
 * path and the normal error documents apply.
 */
export function isPnextInternalError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.stack) return false
  let located = 0
  for (const line of error.stack.split('\n').slice(1)) {
    const file = FRAME_PATH.exec(line)?.[1]
    if (!file || file.includes('native')) continue
    located += 1
    const pnextOwn =
      file.includes('/@wular/pnext/') || /\/pnext\/(src|dist)\//.test(file.replace(/\\/g, '/'))
    if (!pnextOwn) return false
  }
  return located > 0
}

export interface InternalErrorContext {
  error: Error
  route: string
  url: string
  digest?: string
}

function reportUrl(context: InternalErrorContext, version: string): string {
  const title = `[dev] ${context.error.message.split('\n')[0]!.slice(0, 90)}`
  // Home-relative paths: less noise, and the reporter's username stays out of the issue.
  const stack = (context.error.stack ?? context.error.message)
    .split('\n')
    .map(line => {
      const file = FRAME_PATH.exec(line)?.[1]
      return file ? line.replace(file, shortPath(file)) : line
    })
    .join('\n')
  const runtime = `${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`} · ${process.platform} ${process.arch}`
  const body = [
    `**pnext:** ${version} (dev)`,
    `**Runtime:** ${runtime}`,
    `**Route:** \`${context.route}\``,
    context.digest ? `**Digest:** \`${context.digest}\`` : '',
    '',
    '**Error:**',
    '```',
    stack.slice(0, MAX_ISSUE_BODY),
    '```',
    '',
    '<!-- What were you doing when this happened? Does it reproduce after a reload? -->',
  ]
    .filter(Boolean)
    .join('\n')
  return `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

const css = `:root{--bg:#fafafa;--fg:#1a1a1a;--muted:#767676;--faint:#ababab;--accent:#c43030;--card:#f1f1f1;--border:rgba(0,0,0,.09);--btn-bg:#1a1a1a;--btn-fg:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#e6e6e6;--muted:#888;--faint:#5c5c5c;--accent:#f07878;--card:#1a1a1a;--border:rgba(255,255,255,.09);--btn-bg:#e6e6e6;--btn-fg:#111}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;align-items:center;justify-content:center}
main{width:min(640px,calc(100vw - 32px));background:var(--card);border:1px solid var(--border);border-radius:8px;padding:24px 26px;box-shadow:0 8px 32px rgba(0,0,0,.12);margin:24px 0}
.badge{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
h1{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14.5px;font-weight:600;margin:0 0 8px;line-height:1.55;overflow-wrap:anywhere}
p.meta{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);margin:0 0 18px;overflow-wrap:anywhere}
.trace{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.9;overflow:auto;max-height:280px}
.frame{white-space:nowrap}
.frame .fn{color:var(--fg)}
.frame .loc{color:var(--muted);margin-left:12px}
.frame.native{color:var(--faint)}
.frame.native .loc{color:var(--faint)}
.actions{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
.actions a,.actions button{display:inline-flex;align-items:center;height:30px;padding:0 12px;font-family:inherit;font-size:12.5px;font-weight:500;border-radius:5px;cursor:pointer;text-decoration:none;border:1px solid var(--border);background:transparent;color:var(--fg)}
.actions .primary{background:var(--btn-bg);color:var(--btn-fg);border:1px solid transparent}
p.note{font-size:12px;color:var(--muted);margin:16px 0 0;line-height:1.6}`

// `at fn (path:line:col)` / `at path:line:col`; frames render as aligned fn + location rows.
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::(\d+):(\d+))?\)?\s*$/

function shortPath(file: string): string {
  const modules = file.lastIndexOf('node_modules/')
  if (modules >= 0) return file.slice(modules + 'node_modules/'.length)
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const home = process.env.HOME
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file
}

function traceHtml(stack: string): string {
  const rows = stack
    .split('\n')
    .slice(1)
    .map(line => {
      const match = FRAME.exec(line)
      if (!match) return `<div class="frame native">${escapeHtml(line.trim())}</div>`
      const [, fn, file, lineNo, col] = match
      const native = !file!.startsWith('/') && !file!.startsWith('file:')
      const location = native ? file! : `${shortPath(file!)}${lineNo ? `:${lineNo}:${col}` : ''}`
      return `<div class="frame${native ? ' native' : ''}"><span class="fn">${escapeHtml(fn ?? '<anonymous>')}</span><span class="loc">${escapeHtml(location)}</span></div>`
    })
  return rows.join('')
}

/** The full standalone document (own `<html>`), served like a global-error page. Dev only. */
export function internalErrorHtml(context: InternalErrorContext): string {
  const version = pnextVersionRange().slice(1)
  const rawStack = context.error.stack ?? context.error.message
  const details = [
    `pnext ${version}`,
    context.route,
    context.digest ? `digest ${context.digest}` : '',
    context.url,
  ]
    .filter(Boolean)
    .join('  ·  ')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>pnext internal error</title><style>${css}</style></head><body><main><span class="badge">pnext internal error</span><h1>${escapeHtml(context.error.message.split('\n')[0]!)}</h1><p class="meta">${escapeHtml(details)}</p><div class="trace" data-raw="${escapeHtml(rawStack)}">${traceHtml(rawStack)}</div><div class="actions"><a class="primary" href="${escapeHtml(reportUrl(context, version))}" target="_blank" rel="noreferrer">Report on GitHub</a><button onclick="navigator.clipboard.writeText(document.querySelector('.trace').dataset.raw).then(()=>{this.textContent='Copied'})">Copy trace</button><form style="margin:0"><button type="submit">Reload</button></form></div><p class="note">This error came from inside pnext, not your application code. Reload usually recovers in dev; if it repeats, the GitHub report above is prefilled with everything we know.</p></main></body></html>`
}
