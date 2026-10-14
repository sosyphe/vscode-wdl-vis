import { describe, expect, it } from 'vitest'

import { flattenOutline, outline } from '../src/language/outline'
import type { OutlineNode } from '../src/language/outline'
import { SAMPLE, slice } from './fixtures'

/** `name (detail)` per level, so a whole tree can be compared at a glance. */
function tree(nodes: OutlineNode[]): string[] {
  const out: string[] = []
  const walk = (list: OutlineNode[], depth: number): void => {
    for (const node of list) {
      out.push(`${'  '.repeat(depth)}${node.name}${node.detail ? ` — ${node.detail}` : ''}`)
      walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

describe('outline', () => {
  const nodes = outline(SAMPLE)

  it('mirrors the document structure', () => {
    expect(tree(nodes)).toEqual([
      'Config',
      'pipeline',
      '  input',
      '  scatter (sample in reads)',
      '    call aligned — lib.align',
      '    if (depth > 20)',
      '      call qc',
      '  call report',
      '  output',
      'align',
      '  input',
      '  command',
      '  output',
      '  runtime',
      'report',
      '  command',
      '  runtime',
    ])
  })

  it('reports the kind of every node', () => {
    expect(nodes.map((n) => n.kind)).toEqual(['struct', 'workflow', 'task', 'task'])
    expect(nodes[1].children.map((n) => n.kind)).toEqual([
      'input',
      'scatter',
      'call',
      'output',
    ])
  })

  it('gives each node a range covering its whole block', () => {
    const workflow = nodes[1]
    expect(slice(SAMPLE, workflow.range).startsWith('workflow pipeline {')).toBe(true)
    expect(slice(SAMPLE, workflow.range).endsWith('}')).toBe(true)

    const command = nodes[2].children.find((n) => n.kind === 'command')!
    expect(slice(SAMPLE, command.range).startsWith('command <<<')).toBe(true)
    expect(slice(SAMPLE, command.range).endsWith('>>>')).toBe(true)
  })

  it('selects the name for named blocks and the header for anonymous ones', () => {
    const workflow = nodes[1]
    expect(slice(SAMPLE, workflow.selectionRange)).toBe('pipeline')

    const input = workflow.children[0]
    expect(slice(SAMPLE, input.selectionRange)).toBe('input')

    const scatter = workflow.children[1]
    expect(slice(SAMPLE, scatter.selectionRange)).toBe('scatter (sample in reads)')

    const call = scatter.children[0]
    // The alias, not the dotted task name — that is what the user sees.
    expect(slice(SAMPLE, call.selectionRange)).toBe('aligned')
  })

  it('keeps a child range inside its parent range', () => {
    for (const node of flattenOutline(nodes)) {
      for (const child of node.children) {
        expect(child.range.start).toBeGreaterThanOrEqual(node.range.start)
        expect(child.range.end).toBeLessThanOrEqual(node.range.end)
      }
      expect(node.selectionRange.start).toBeGreaterThanOrEqual(node.range.start)
      expect(node.selectionRange.end).toBeLessThanOrEqual(node.range.end)
    }
  })

  it('only sets `detail` where it adds information', () => {
    const withDetail = flattenOutline(nodes).filter((n) => n.detail !== '')
    expect(withDetail.map((n) => `${n.name}=${n.detail}`)).toEqual(['call aligned=lib.align'])
  })

  it('returns an empty list for text with no blocks', () => {
    expect(outline('')).toEqual([])
    expect(outline('version 1.0\n# just a comment\n')).toEqual([])
  })

  it('survives malformed input', () => {
    expect(() => outline('workflow w { call a { input: x = 1')).not.toThrow()
    expect(outline('workflow w { input { Int x } }')).toHaveLength(1)
  })
})
