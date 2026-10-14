// ScanCache is what stops one document being scanned over and over: the
// definition, symbol and folding providers all consume the same block tree, and
// VS Code calls each of them repeatedly for what the user experiences as a
// single gesture.
//
// The interesting cases are the invalidation ones. `version` alone is *not* a
// safe key — the mocks pin it at 1 while feeding one URI many different texts,
// and a real document closed and reopened can come back on a colliding version —
// so the cache also compares the text. Those tests are the reason this class
// exists rather than being a bare `Map` keyed on version.

import { describe, expect, it } from 'vitest'

import { ScanCache } from '../src/language/scanCache'
import { scanDocument } from '../src/language/scanner'
import { parseImports } from '../src/language/imports'
import { SAMPLE } from './fixtures'

const URI = 'file:///workspace/main.wdl'

/** A second document with a different shape, for eviction and keying tests. */
const OTHER = `version 1.0
workflow other {
  call helper
}
task helper {
  command { true }
}
`

describe('ScanCache.blocksFor', () => {
  it('returns the same blocks a fresh scan would', () => {
    const cache = new ScanCache()
    expect(cache.blocksFor(URI, 1, SAMPLE)).toEqual(scanDocument(SAMPLE))
  })

  it('reuses the identical array on a repeat call', () => {
    const cache = new ScanCache()
    const first = cache.blocksFor(URI, 1, SAMPLE)
    const second = cache.blocksFor(URI, 1, SAMPLE)
    expect(second).toBe(first) // same object, not merely equal
    expect(cache.stats.hits).toBe(1)
    expect(cache.stats.misses).toBe(1)
  })

  it('rescans when the text changes but the version does not', () => {
    // Exactly the situation the mocks create, and the reason version alone
    // cannot be the key: same URI, same version, different document.
    const cache = new ScanCache()
    const before = cache.blocksFor(URI, 1, SAMPLE)
    const after = cache.blocksFor(URI, 1, OTHER)

    expect(after).not.toBe(before)
    expect(after).toEqual(scanDocument(OTHER))
    expect(cache.stats.hits).toBe(0)
    expect(cache.stats.misses).toBe(2)
  })

  it('rescans when the version changes', () => {
    const cache = new ScanCache()
    const before = cache.blocksFor(URI, 1, SAMPLE)
    const after = cache.blocksFor(URI, 2, SAMPLE)

    expect(after).not.toBe(before)
    expect(after).toEqual(scanDocument(SAMPLE))
  })

  it('keys documents separately by URI', () => {
    const cache = new ScanCache()
    const a = cache.blocksFor('file:///a.wdl', 1, SAMPLE)
    const b = cache.blocksFor('file:///b.wdl', 1, SAMPLE)

    expect(b).not.toBe(a)
    expect(cache.size).toBe(2)
  })
})

describe('ScanCache eviction', () => {
  it('drops the least-recently-used document past the cap', () => {
    const cache = new ScanCache(2)
    cache.blocksFor('file:///a.wdl', 1, SAMPLE)
    cache.blocksFor('file:///b.wdl', 1, SAMPLE)
    cache.blocksFor('file:///c.wdl', 1, SAMPLE)

    expect(cache.size).toBe(2)
    // `a` was the oldest and should have been the one evicted.
    const missesBefore = cache.stats.misses
    cache.blocksFor('file:///a.wdl', 1, SAMPLE)
    expect(cache.stats.misses).toBe(missesBefore + 1)
  })

  it('treats a read as a use, so a touched entry survives eviction', () => {
    const cache = new ScanCache(2)
    const a = cache.blocksFor('file:///a.wdl', 1, SAMPLE)
    cache.blocksFor('file:///b.wdl', 1, SAMPLE)
    cache.blocksFor('file:///a.wdl', 1, SAMPLE) // refresh `a`'s recency
    cache.blocksFor('file:///c.wdl', 1, SAMPLE) // evicts `b`, not `a`

    expect(cache.blocksFor('file:///a.wdl', 1, SAMPLE)).toBe(a)
  })
})

describe('ScanCache invalidation', () => {
  it('drops a single document on invalidate', () => {
    const cache = new ScanCache()
    const first = cache.blocksFor(URI, 1, SAMPLE)
    cache.invalidate(URI)

    expect(cache.size).toBe(0)
    expect(cache.blocksFor(URI, 1, SAMPLE)).not.toBe(first)
    expect(cache.stats.misses).toBe(2)
  })

  it('ignores an invalidate for a document it never held', () => {
    const cache = new ScanCache()
    cache.blocksFor(URI, 1, SAMPLE)
    expect(() => cache.invalidate('file:///never-seen.wdl')).not.toThrow()
    expect(cache.size).toBe(1)
  })

  it('drops everything on clear', () => {
    const cache = new ScanCache()
    cache.blocksFor('file:///a.wdl', 1, SAMPLE)
    cache.blocksFor('file:///b.wdl', 1, OTHER)
    cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.stats).toEqual({ hits: 0, misses: 2, size: 0 })
  })
})

describe('ScanCache.importsFor', () => {
  it('returns the same imports a fresh parse would', () => {
    const cache = new ScanCache()
    const blocks = cache.blocksFor(URI, 1, SAMPLE)
    expect(cache.importsFor(URI, 1, SAMPLE, blocks)).toEqual(parseImports(SAMPLE, blocks))
  })

  it('memoizes the parse, so a second call does not redo the regex pass', () => {
    const cache = new ScanCache()
    const blocks = cache.blocksFor(URI, 1, SAMPLE)
    const first = cache.importsFor(URI, 1, SAMPLE, blocks)
    const second = cache.importsFor(URI, 1, SAMPLE, blocks)

    expect(second).toBe(first) // same array object
  })

  it('recomputes imports when the text changes', () => {
    const cache = new ScanCache()
    const before = cache.importsFor(URI, 1, SAMPLE, cache.blocksFor(URI, 1, SAMPLE))
    const after = cache.importsFor(URI, 1, OTHER, cache.blocksFor(URI, 1, OTHER))

    expect(before.map((i) => i.path)).toEqual(['lib.wdl'])
    expect(after).toEqual([])
  })

  it('does not disturb the blocks entry', () => {
    const cache = new ScanCache()
    const blocks = cache.blocksFor(URI, 1, SAMPLE)
    cache.importsFor(URI, 1, SAMPLE, blocks)

    expect(cache.blocksFor(URI, 1, SAMPLE)).toBe(blocks)
    expect(cache.size).toBe(1)
  })
})
