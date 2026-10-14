// Trailing-edge debounce with an injectable timer so it can be unit tested
// without real waiting. Deliberately not imported from a dependency.

export interface Timer {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const defaultTimer: Timer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** Drop any pending invocation without running it. */
  cancel(): void
  /** Run a pending invocation immediately, if there is one. */
  flush(): void
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  timer: Timer = defaultTimer
): Debounced<A> {
  let handle: unknown = null
  let pending: A | null = null

  const invoke = () => {
    handle = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }

  const debounced = ((...args: A) => {
    pending = args
    if (handle !== null) timer.clearTimeout(handle)
    handle = timer.setTimeout(invoke, waitMs)
  }) as Debounced<A>

  debounced.cancel = () => {
    if (handle !== null) timer.clearTimeout(handle)
    handle = null
    pending = null
  }

  debounced.flush = () => {
    if (handle === null) return
    timer.clearTimeout(handle)
    invoke()
  }

  return debounced
}
