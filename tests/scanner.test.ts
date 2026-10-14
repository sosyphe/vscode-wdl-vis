import { describe, expect, it } from 'vitest'

import { blockDisplayName, scanDocument } from '../src/language/scanner'
import type { BlockKind, ScannedBlock } from '../src/language/scanner'
import { SAMPLE, slice } from './fixtures'

/** Blocks whose `parent` is the first block matching `kind`/`name`. */
function childrenOf(
  blocks: ScannedBlock[],
  kind: BlockKind,
  name: string | null = null
): ScannedBlock[] {
  const parentIndex = blocks.findIndex((b) => b.kind === kind && (name === null || b.name === name))
  expect(parentIndex, `no ${kind} ${name ?? ''} block found`).toBeGreaterThanOrEqual(0)
  return blocks.filter((b) => b.parent === parentIndex)
}

/** `childrenOf` already returns a single level, so names alone describe it. */
function shape(blocks: ScannedBlock[]): string[] {
  return blocks.map((b) => blockDisplayName(b))
}

describe('scanDocument', () => {
  const blocks = scanDocument(SAMPLE)

  it('finds every top-level block in document order', () => {
    expect(blocks.filter((b) => b.depth === 0).map((b) => `${b.kind} ${b.name}`)).toEqual([
      'struct Config',
      'workflow pipeline',
      'task align',
      'task report',
    ])
  })

  it('nests workflow sections, scatter, if and calls', () => {
    expect(shape(childrenOf(blocks, 'workflow', 'pipeline'))).toEqual([
      'input',
      'scatter (sample in reads)',
      'call report',
      'output',
    ])
    expect(shape(childrenOf(blocks, 'scatter'))).toEqual([
      'call aligned',
      'if (depth > 20)',
    ])
    expect(shape(childrenOf(blocks, 'if'))).toEqual(['call qc'])
  })

  it('nests task sections without recursing into opaque bodies', () => {
    expect(shape(childrenOf(blocks, 'task', 'align'))).toEqual([
      'input',
      'command',
      'output',
      'runtime',
    ])
    expect(shape(childrenOf(blocks, 'task', 'report'))).toEqual(['command', 'runtime'])
  })

  it('records the alias separately from the called task', () => {
    const call = blocks.find((b) => b.kind === 'call' && b.alias === 'aligned')
    expect(call?.name).toBe('lib.align')
    expect(call?.alias).toBe('aligned')
    expect(blockDisplayName(call!)).toBe('call aligned')
    // The selection range covers the alias, not the dotted task name.
    expect(SAMPLE.slice(call!.nameStart, call!.nameEnd)).toBe('aligned')
  })

  it('marks a bare `call` as bodyless and ends it at the line break', () => {
    const call = blocks.find((b) => b.kind === 'call' && b.name === 'report')!
    expect(call.hasBody).toBe(false)
    expect(call.braceStart).toBe(-1)
    expect(slice(SAMPLE, { start: call.start, end: call.end })).toBe('call report')
  })

  it('captures the if/scatter header without its parentheses', () => {
    const scatter = blocks.find((b) => b.kind === 'scatter')!
    const conditional = blocks.find((b) => b.kind === 'if')!
    expect(scatter.header).toBe('sample in reads')
    expect(conditional.header).toBe('depth > 20')
  })

  it('treats a heredoc command as opaque, even with braces and quotes inside', () => {
    const command = childrenOf(blocks, 'task', 'align').find((b) => b.kind === 'command')!
    expect(command.hasBody).toBe(true)
    expect(command.braceStart).toBe(-1)
    const text = slice(SAMPLE, { start: command.start, end: command.end })
    expect(text.startsWith('command <<<')).toBe(true)
    expect(text.endsWith('>>>')).toBe(true)
    // `echo "}"` inside the shell body must not have closed anything early.
    expect(text).toContain('echo "}"')
  })

  it('balances nested braces inside a brace command', () => {
    const command = childrenOf(blocks, 'task', 'report').find((b) => b.kind === 'command')!
    const text = slice(SAMPLE, { start: command.start, end: command.end })
    expect(text).toContain("awk '{print}'")
    expect(text.endsWith('}')).toBe(true)
  })

  it('ignores keywords in comments and strings', () => {
    const text = ['# task decoy {', 'workflow real {', '  String s = "task fake {"', '}'].join('\n')
    const scanned = scanDocument(text)
    expect(scanned.map((b) => `${b.kind}:${b.name}`)).toEqual(['workflow:real'])
    expect(slice(text, { start: scanned[0].start, end: scanned[0].end })).toBe(
      'workflow real {\n  String s = "task fake {"\n}'
    )
  })

  it('does not mistake `input:` inside a call for an input block', () => {
    const call = blocks.find((b) => b.kind === 'call' && b.alias === 'aligned')!
    const callIndex = blocks.indexOf(call)
    expect(call.hasBody).toBe(true)
    // The colon form is a call argument list, not a section — nothing nests here.
    expect(blocks.filter((b) => b.parent === callIndex)).toEqual([])
    // …and the only `input` blocks are the two real section headers.
    expect(blocks.filter((b) => b.kind === 'input')).toHaveLength(2)
  })

  it('never throws on malformed input, truncating at the limit instead', () => {
    expect(() => scanDocument('workflow broken { task')).not.toThrow()
    expect(scanDocument('workflow broken { task')).toEqual([])
    expect(() => scanDocument('task x { command <<< never closed')).not.toThrow()
    expect(() => scanDocument('}}}} call')).not.toThrow()
    expect(() => scanDocument('')).not.toThrow()
    expect(scanDocument('')).toEqual([])
  })

  it('emits blocks pre-order so a parent always precedes its children', () => {
    blocks.forEach((block, index) => {
      if (block.parent === -1) return
      expect(block.parent).toBeLessThan(index)
      expect(blocks[block.parent].depth).toBe(block.depth - 1)
    })
  })
})

describe('blockDisplayName', () => {
  it('falls back to the kind for anonymous blocks', () => {
    const [block] = scanDocument('workflow w { input { } }')
    expect(blockDisplayName(block)).toBe('w')
    const input = scanDocument('workflow w { input { } }')[1]
    expect(blockDisplayName(input)).toBe('input')
  })
})
