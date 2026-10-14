import { describe, expect, it, vi } from 'vitest'

import { debounce } from '../src/util/debounce'
import { fakeClock } from './fakeClock'

describe('debounce', () => {
  it('waits for the trailing edge', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    debounced()
    clock.advance(299)
    expect(fn).not.toHaveBeenCalled()

    clock.advance(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst into one call with the latest arguments', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    debounced('a')
    clock.advance(100)
    debounced('b')
    clock.advance(100)
    debounced('c')
    clock.advance(300)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('c')
  })

  it('restarts the window on every call', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    for (let i = 0; i < 10; i++) {
      debounced(i)
      clock.advance(200)
    }
    expect(fn).not.toHaveBeenCalled()

    clock.advance(300)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(9)
    // Only one timer is ever outstanding.
    expect(clock.pending()).toBe(0)
  })

  it('fires again for a second, separated burst', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    debounced(1)
    clock.advance(300)
    debounced(2)
    clock.advance(300)

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel() drops a pending call', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    debounced()
    debounced.cancel()
    clock.advance(1000)

    expect(fn).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(0)
  })

  it('cancel() is a no-op when nothing is pending', () => {
    const clock = fakeClock()
    const debounced = debounce(() => {}, 300, clock)
    expect(() => debounced.cancel()).not.toThrow()
    debounced()
    clock.advance(300)
    expect(() => debounced.cancel()).not.toThrow()
  })

  it('flush() runs a pending call immediately', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    const debounced = debounce(fn, 300, clock)

    debounced('now')
    debounced.flush()

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('now')
    // …and the scheduled timer is gone, so it does not fire twice.
    clock.advance(1000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush() does nothing when idle', () => {
    const clock = fakeClock()
    const fn = vi.fn()
    debounce(fn, 300, clock).flush()
    expect(fn).not.toHaveBeenCalled()
  })
})
