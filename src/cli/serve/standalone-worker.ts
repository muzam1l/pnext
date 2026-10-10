// Traces the framework's standalone closure off the build's main thread (see startStandalone).
import { traceFramework } from './standalone'

declare const self: Worker

self.onmessage = async (event: MessageEvent) => {
  self.postMessage(await traceFramework(event.data as Parameters<typeof traceFramework>[0]))
}
