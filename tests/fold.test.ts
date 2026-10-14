import { describe, expect, it } from 'vitest'

import { folds } from '../src/language/fold'
import type { FoldRange } from '../src/language/fold'
import { SAMPLE, lineOf } from './fixtures'

/** Line index of the first line containing `needle`. */
function lineWith(needle: string, from = 0): number {
  const index = SAMPLE.indexOf(needle, from)
  expect(index, `"${needle}" not in fixture`).toBeGreaterThanOrEqual(0)
  return lineOf(SAMPLE, index)
}

function lines(fold: FoldRange): { start: number; end: number } {
  return { start: lineOf(SAMPLE, fold.start), end: lineOf(SAMPLE, fold.end) }
}

describe('folds', () => {
  const ranges = folds(SAMPLE)

  it('offers a range for every block that has a body', () => {
    expect(ranges.map((r) => r.kind)).toEqual([
      'struct',
      'workflow',
      'input',
      'scatter',
      'call',
      'if',
      'call',
      'output',
      'task',
      'input',
      'command',
      'output',
      'runtime',
      'task',
      'command',
      'runtime',
    ])
  })

  it('skips a bare `call` — there is nothing to hide', () => {
    const bare = SAMPLE.indexOf('call report')
    expect(ranges.some((r) => r.start === bare)).toBe(false)
    // …but the two calls that do have argument lists are present.
    expect(ranges.filter((r) => r.kind === 'call')).toHaveLength(2)
  })

  it('spans a workflow from its keyword to its closing brace', () => {
    const workflow = ranges.find((r) => r.kind === 'workflow')!
    expect(lines(workflow)).toEqual({
      start: lineWith('workflow pipeline {'),
      end: lineWith('workflow pipeline {') + 26,
    })
  })

  it('ends a heredoc command at the >>> line, not at a brace inside the shell', () => {
    const heredoc = ranges.filter((r) => r.kind === 'command')[0]
    expect(lines(heredoc)).toEqual({
      start: lineWith('command <<<'),
      end: lineWith('>>>'),
    })
    // `echo "}"` sits between them and must not have ended the block early.
    const braceLine = lineWith('echo "}"')
    expect(braceLine).toBeGreaterThan(lines(heredoc).start)
    expect(braceLine).toBeLessThan(lines(heredoc).end)
  })

  it('ends a brace command at its own closing brace despite nested shell braces', () => {
    const braceCommand = ranges.filter((r) => r.kind === 'command')[1]
    const start = lineWith("command {", lineWith('task report {'))
    expect(lines(braceCommand).start).toBe(start)
    expect(lines(braceCommand).end).toBe(start + 2)
  })

  it('nests: every inner range sits inside an outer one', () => {
    const sorted = [...ranges].sort((a, b) => a.start - b.start)
    for (const range of sorted) {
      const enclosing = sorted.filter(
        (other) => other.start < range.start && other.end >= range.end
      )
      // Top-level blocks (struct/workflow/task) have no enclosure; everything
      // else must have at least one.
      if (['struct', 'workflow', 'task'].includes(range.kind)) {
        expect(enclosing).toEqual([])
      } else {
        expect(enclosing.length).toBeGreaterThan(0)
      }
    }
  })

  it('spans at least two lines, so the provider never emits a no-op fold', () => {
    for (const range of ranges) {
      expect(lines(range).end).toBeGreaterThan(lines(range).start)
    }
  })

  it('returns nothing for text without blocks', () => {
    expect(folds('')).toEqual([])
    expect(folds('version 1.0\ncall foo\n')).toEqual([])
  })
})
