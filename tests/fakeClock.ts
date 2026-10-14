// Deterministic clock for the injectable `Timer` interface in src/debounce.ts.
// Nothing fires until the test advances it, so debounce behaviour is exact.

import type { Timer } from '../src/util/debounce'

export interface FakeClock extends Timer {
  /** Run everything scheduled within the next `ms`, in time order. */
  advance(ms: number): void
  /** Number of timers still outstanding. */
  pending(): number
}

export function fakeClock(): FakeClock {
  let now = 0
  let seq = 0
  const scheduled = new Map<number, { at: number; fn: () => void }>()

  return {
    setTimeout(fn, ms) {
      const id = ++seq
      scheduled.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number)
    },
    advance(ms) {
      const target = now + ms
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
    pending: () => scheduled.size,
  }
}
