/**
 * Pre-hydration server-action form capture (Next parity).
 *
 * React/Next capture form submissions that happen BEFORE hydration and replay them once the client
 * runtime is up, instead of letting the browser run the native progressive POST (which reloads the
 * document, losing pending client state and streaming the response into a half-parsed page). This
 * inline script mirrors that: it queues the submission (FormData snapshotted at submit time, including
 * the submitter's pair) on the form node and in `window.__pnextEarlySubmits`; the action client
 * runtime replays queued submissions when the form hydrates, or falls back to the native submit if
 * hydration never claims it.
 *
 * Emitted for every next-compat document after the body content, so the forms it guards are parsed.
 */
export function earlySubmitCaptureScript(): string {
  // Keep in sync with compat/actions/protocol.ts field names.
  return (
    '(function(){var h=function(e){' +
    "var f=e.target;if(!f||f.nodeName!=='FORM')return;" +
    'if(f.__pnextNativeReplay){f.__pnextNativeReplay=0;return;}' +
    'if(e.defaultPrevented||window.__PNEXT_ACTIONS__)return;' +
    'var s=e.submitter||null;' +
    'var m=f.querySelector(\'input[name="$pnext_action_id"],input[name="$pnext_form_state"]\');' +
    "if(!m&&!(s&&s.getAttribute('name')==='$pnext_submit_action_id'))return;" +
    'e.preventDefault();' +
    'var d;try{d=new FormData(f,s||undefined)}catch(_){d=new FormData(f)}' +
    'f.__pnextQueuedSubmit={data:d,submitter:s};' +
    '(window.__pnextEarlySubmits=window.__pnextEarlySubmits||[]).push(f);' +
    // A page whose route emits no client runtime never drains the queue —
    // fall back to the browser's native progressive POST (the whole point of
    // progressive enhancement) once hydration has clearly not claimed it.
    'setTimeout(function(){' +
    'if(window.__PNEXT_ACTIONS__||!f.__pnextQueuedSubmit)return;' +
    'f.__pnextQueuedSubmit=undefined;f.__pnextNativeReplay=1;' +
    'try{s?f.requestSubmit(s):f.requestSubmit()}catch(_){f.submit()}' +
    '},3000);' +
    '};document.addEventListener("submit",h,false);' +
    'window.__pnextRemoveEarlySubmit=function(){document.removeEventListener("submit",h,false)};' +
    '})();'
  )
}
