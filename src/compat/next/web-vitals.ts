'use client'

// `next/web-vitals` compat surface. Next measures Core Web Vitals (plus its own Next.js-* custom
// metrics) and invokes the reporter callback per registered hook instance. The Core Web Vitals are
// backed by the `web-vitals` package - this is browser-bundled client code, so the import stays a plain
// static import for the bundler to resolve. Next's own custom metrics are not emitted here.
import { useEffect, useRef } from 'preact/hooks'
import * as webVitals from 'web-vitals'
import type { Metric } from 'web-vitals'

export interface NextWebVitalsMetric {
  id: string
  name: string
  startTime: number
  value: number
  label: 'web-vital' | 'custom'
}

export function useReportWebVitals(reportWebVitalsFn: (metric: NextWebVitalsMetric) => void): void {
  // Route metrics through a ref so the latest reporter identity receives them
  // without resubscribing to web-vitals on every render.
  const reporterRef = useRef(reportWebVitalsFn)
  useEffect(() => {
    reporterRef.current = reportWebVitalsFn
  }, [reportWebVitalsFn])

  useEffect(() => {
    const report = (metric: Metric): void => {
      reporterRef.current({
        id: metric.id,
        name: metric.name,
        startTime: metric.entries[0]?.startTime ?? 0,
        value: metric.value,
        label: 'web-vital',
      })
    }

    webVitals.onTTFB(report)
    webVitals.onFCP(report)
    webVitals.onLCP(report)
    // CLS and INP accumulate over the page lifetime and, by default, only settle
    // when the page is hidden. A page that is never hidden (or one torn down by a
    // navigation before the visibilitychange flush lands) therefore never reports
    // them at all. Both metrics are documented as multi-report: `reportAllChanges`
    // emits each new value as it is determined instead of a single deferred one,
    // so opting in makes delivery deterministic without dropping any information.
    webVitals.onCLS(report, { reportAllChanges: true })
    webVitals.onINP(report, { reportAllChanges: true })
    // `onFID` is deprecated (removed in newer majors); subscribe only if present.
    if (typeof webVitals.onFID === 'function') {
      webVitals.onFID(report)
    }
  }, [])
}
