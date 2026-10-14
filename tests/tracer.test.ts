// Tracer is how a slow Ctrl+click gets attributed. The whole reason it exists is
// that the scan measures in single-digit milliseconds while users report
// seconds, so the distinction these tests pin down matters: timings and gesture
// counts are always accumulated (so `wdl.showDiagnostics` has data from before
// tracing was switched on), while *writing* and the lag probe are gated on the
// setting — a perpetual timer would otherwise keep the host from ever idling.

import { describe, expect, it } from 'vitest'

import { Tracer, nullTracer } from '../src/util/tracer'
import type { TraceChannel } from '../src/util/tracer'
import type { Timer } from '../src/util/debounce'

interface FakeTime {
  now(): number
  timer: Timer
  /** Advance, running each callback at its scheduled instant (no artificial lag). */
  advance(ms: number): void
  /**
   * Model a blocked event loop: the clock jumps forward *first*, then whatever
   * fell due runs — so each callback observes itself as late.
   */
  stall(ms: number): void
  pending(): number
}

/**
 * `tests/fakeClock.ts` keeps its own timeline, which cannot express "the timer
 * fired late". The lag probe is exactly that, so this harness drives the clock
 * and the timer from one shared `now`.
 */
function fakeTime(): FakeTime {
  let now = 0
  let seq = 0
  const scheduled = new Map<number, { at: number; fn: () => void }>()

  const runDue = (): void => {
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | null = null
      for (const [id, entry] of scheduled) {
        if (entry.at <= now && (next === null || entry.at < next.at)) next = { id, ...entry }
      }
      if (!next) break
      scheduled.delete(next.id)
      next.fn()
    }
  }

  return {
    now: () => now,
    timer: {
      setTimeout: (fn, ms) => {
        const id = ++seq
        scheduled.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout: (handle) => {
        scheduled.delete(handle as number)
      },
    },
    advance(ms) {
      const target = now + ms
      // Step to each due instant in order so callbacks see their real wake time.
      for (;;) {
        let next: { id: number; at: number; fn: () => void } | null = null
        for (const [id, entry] of scheduled) {
          if (entry.at <= target && (next === null || entry.at < next.at)) next = { id, ...entry }
        }
        if (!next) break
        scheduled.delete(next.id)
        now = next.at
        next.fn()
      }
      now = target
    },
    stall(ms) {
      now += ms
      runDue()
    },
    pending: () => scheduled.size,
  }
}

interface Harness {
  tracer: Tracer
  lines: string[]
  channels: TraceChannel[]
  shown: number[]
  disposed: boolean[]
  setEnabled(value: boolean): void
  time: FakeTime
}

function harness(options: { enabled?: boolean; now?: () => number } = {}): Harness {
  const lines: string[] = []
  const channels: TraceChannel[] = []
  const shown: number[] = []
  const disposed: boolean[] = []
  let enabled = options.enabled ?? true
  const time = fakeTime()

  const tracer = new Tracer({
    enabled: () => enabled,
    createChannel: () => {
      const channel: TraceChannel = {
        appendLine: (line: string) => lines.push(line),
        show: () => shown.push(channels.length),
        dispose: () => {
          disposed[channels.length] = true
        },
      }
      channels.push(channel)
      return channel
    },
    now: options.now ?? time.now,
    timer: time.timer,
  })

  return {
    tracer,
    lines,
    channels,
    shown,
    disposed,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    time,
  }
}

/** Run a span whose measured work takes `costMs` on the fake timeline. */
function runSpan(h: Harness, label: string, costMs: number, detail?: string): void {
  const span = h.tracer.span(label)
  h.time.advance(costMs)
  span.stop(detail)
}

describe('Tracer output gating', () => {
  it('creates no channel and writes nothing while disabled', () => {
    const h = harness({ enabled: false })
    runSpan(h, 'provideDefinition', 5)

    expect(h.channels).toHaveLength(0)
    expect(h.lines).toEqual([])
  })

  it('still counts calls while disabled, so the summary has history', () => {
    const h = harness({ enabled: false })
    runSpan(h, 'provideDefinition', 5)
    runSpan(h, 'provideDefinition', 5)

    const stats = h.tracer.snapshot
    expect(stats.calls).toBe(2)
    expect(stats.totalMs).toBeGreaterThanOrEqual(10)
  })

  it('creates the channel lazily, on the first line actually written', () => {
    const h = harness()
    expect(h.channels).toHaveLength(0)

    runSpan(h, 'provideDefinition', 1)
    expect(h.channels).toHaveLength(1)

    runSpan(h, 'provideDefinition', 1)
    expect(h.channels).toHaveLength(1) // one channel, reused
  })

  it('writes nothing more once switched back off', () => {
    const h = harness()
    runSpan(h, 'provideDefinition', 1)
    const written = h.lines.length

    h.setEnabled(false)
    runSpan(h, 'provideDefinition', 1)
    expect(h.lines).toHaveLength(written)
  })

  it('gates note() the same way', () => {
    const h = harness({ enabled: false })
    h.tracer.note('post sent 100 chars')
    expect(h.lines).toEqual([])

    h.setEnabled(true)
    h.tracer.note('post sent 100 chars')
    expect(h.lines).toEqual(['post sent 100 chars'])
  })
})

describe('Tracer span timings', () => {
  it('reports the label, total, and phase breakdown', () => {
    const h = harness()
    const span = h.tracer.span('provideDefinition')
    span.mark('scan')
    h.time.advance(2)
    span.mark('resolve')
    h.time.advance(1)
    span.stop('same-file align')

    expect(h.lines).toHaveLength(1)
    const line = h.lines[0]
    expect(line).toContain('provideDefinition')
    expect(line).toContain('3.00ms')
    expect(line).toContain('scan=2.00ms')
    expect(line).toContain('resolve=1.00ms')
    expect(line).toContain('same-file align')
  })

  it('drops the unnamed interval before the first mark', () => {
    const h = harness()
    const span = h.tracer.span('provideDefinition')
    h.time.advance(5) // before any mark — should not appear as a phase
    span.mark('scan')
    h.time.advance(1)
    span.stop()

    expect(h.lines[0]).toContain('scan=1.00ms')
    expect(h.lines[0]).not.toContain('=5.00ms')
  })

  it('flags a call at or above the slow threshold', () => {
    const h = harness()
    runSpan(h, 'fast', 10)
    runSpan(h, 'slow', 60)

    expect(h.lines[0].startsWith('SLOW')).toBe(false)
    expect(h.lines[1].startsWith('SLOW')).toBe(true)
    expect(h.tracer.snapshot.slowCalls).toBe(1)
  })

  it('records slowest and average across calls', () => {
    const h = harness()
    runSpan(h, 'a', 10)
    runSpan(h, 'b', 30)

    const stats = h.tracer.snapshot
    expect(stats.calls).toBe(2)
    expect(stats.slowestMs).toBe(30)
    expect(stats.totalMs).toBe(40)
  })

  it('ignores a second stop() on the same span', () => {
    const h = harness()
    const span = h.tracer.span('provideDefinition')
    h.time.advance(1)
    span.stop('first')
    span.stop('second')

    expect(h.lines).toHaveLength(1)
    expect(h.tracer.snapshot.calls).toBe(1)
  })

  it('ignores a mark() after stop()', () => {
    const h = harness()
    const span = h.tracer.span('provideDefinition')
    span.mark('scan')
    h.time.advance(1)
    span.stop()
    span.mark('late')

    expect(h.lines).toHaveLength(1)
  })
})

describe('Tracer gesture grouping', () => {
  it('counts calls inside the window as one gesture', () => {
    const h = harness()
    runSpan(h, 'provideDefinition', 1)
    h.time.advance(100) // still inside the 500 ms window
    runSpan(h, 'provideDefinition', 1)

    expect(h.tracer.snapshot.gestures).toBe(1)
    expect(h.tracer.snapshot.maxCallsPerGesture).toBe(2)
    expect(h.lines[1]).toContain('call 2')
  })

  it('starts a new gesture once the window lapses', () => {
    const h = harness()
    runSpan(h, 'provideDefinition', 1)
    h.time.advance(600) // past the 500 ms window
    runSpan(h, 'provideDefinition', 1)

    expect(h.tracer.snapshot.gestures).toBe(2)
    expect(h.tracer.snapshot.maxCallsPerGesture).toBe(1)
    expect(h.lines[1]).toContain('gesture 2')
    expect(h.lines[1]).toContain('call 1')
  })

  it('keeps the worst gesture count seen', () => {
    const h = harness()
    for (let i = 0; i < 4; i++) runSpan(h, 'provideDefinition', 1)
    h.time.advance(600)
    runSpan(h, 'provideDefinition', 1)

    expect(h.tracer.snapshot.maxCallsPerGesture).toBe(4)
    expect(h.tracer.snapshot.gestures).toBe(2)
  })
})

describe('Tracer event-loop lag probe', () => {
  it('is not armed while tracing is off', () => {
    const h = harness({ enabled: false })
    h.tracer.refresh()

    expect(h.time.pending()).toBe(0)
  })

  it('arms a repeating probe when tracing is on', () => {
    const h = harness()
    h.tracer.refresh()
    expect(h.time.pending()).toBe(1)

    h.time.advance(500)
    expect(h.time.pending()).toBe(1) // rescheduled itself
  })

  it('reports a stall when the loop wakes late', () => {
    const h = harness()
    h.tracer.refresh()
    h.time.stall(900) // probe was due at 500, woke at 900

    expect(h.lines.some((line) => line.includes('EVENT LOOP STALLED'))).toBe(true)
    expect(h.tracer.snapshot.lagStalls).toBe(1)
    expect(h.tracer.snapshot.worstLagMs).toBeGreaterThanOrEqual(250)
  })

  it('stays quiet when the loop is keeping up', () => {
    const h = harness()
    h.tracer.refresh()
    h.time.advance(2500) // five punctual probes

    expect(h.lines).toEqual([])
    expect(h.tracer.snapshot.lagStalls).toBe(0)
  })

  it('tracks the worst stall across several', () => {
    const h = harness()
    h.tracer.refresh()
    h.time.stall(800)
    h.time.stall(2000)

    expect(h.tracer.snapshot.lagStalls).toBe(2)
    expect(h.tracer.snapshot.worstLagMs).toBeGreaterThan(1000)
  })

  it('disarms when the setting is turned off mid-session', () => {
    const h = harness()
    h.tracer.refresh()
    expect(h.time.pending()).toBe(1)

    h.setEnabled(false)
    h.tracer.refresh()
    expect(h.time.pending()).toBe(0)
  })

  it('stops rescheduling if disabled between ticks', () => {
    const h = harness()
    h.tracer.refresh()
    h.setEnabled(false)
    h.time.advance(500) // the in-flight tick runs, then declines to reschedule

    expect(h.time.pending()).toBe(0)
  })

  it('does not double-arm on a repeated refresh', () => {
    const h = harness()
    h.tracer.refresh()
    h.tracer.refresh()
    h.tracer.refresh()

    expect(h.time.pending()).toBe(1)
  })
})

describe('Tracer summary', () => {
  it('covers activation, calls, timings and lag', () => {
    const h = harness()
    h.tracer.setActivationMs(12.5)
    runSpan(h, 'provideDefinition', 4)

    const summary = h.tracer.summary().join('\n')
    expect(summary).toContain('activation:')
    expect(summary).toContain('12.50 ms')
    expect(summary).toContain('provider calls:')
    expect(summary).toContain('event-loop lag:')
  })

  it('appends caller-supplied lines', () => {
    const h = harness()
    const summary = h.tracer.summary(['scan cache: 3 hit(s)']).join('\n')
    expect(summary).toContain('scan cache: 3 hit(s)')
  })

  it('explains how to read the numbers', () => {
    // The summary is the user-facing answer to "is it us or the host?", so the
    // interpretation has to ship with the data.
    const summary = harness().tracer.summary().join('\n')
    expect(summary).toContain('extension')
    expect(summary.toLowerCase()).toContain('host')
  })

  it('showSummary writes and reveals the channel even while disabled', () => {
    const h = harness({ enabled: false })
    h.tracer.showSummary(['extra line'])

    expect(h.channels).toHaveLength(1)
    expect(h.lines.join('\n')).toContain('extra line')
    expect(h.shown).toHaveLength(1)
  })

  it('snapshot is a copy, so callers cannot mutate the counters', () => {
    const h = harness()
    runSpan(h, 'provideDefinition', 1)
    const before = h.tracer.snapshot
    before.calls = 999

    expect(h.tracer.snapshot.calls).toBe(1)
  })
})

describe('nullTracer', () => {
  it('never reports itself enabled and creates no channel', () => {
    expect(nullTracer.isEnabled).toBe(false)

    const span = nullTracer.span('provideDefinition')
    span.mark('scan')
    span.stop('detail')
    nullTracer.note('ignored')

    expect(nullTracer.snapshot.calls).toBe(1) // counted, but nothing was written
  })

  it('arms no probe and survives dispose', () => {
    nullTracer.refresh()
    expect(() => nullTracer.dispose()).not.toThrow()
    expect(() => nullTracer.showSummary()).not.toThrow()
  })
})
