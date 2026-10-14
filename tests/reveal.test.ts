import { describe, expect, it } from 'vitest'

import { revealRange } from '../src/language/reveal'
import type { SelectedNode } from '../src/graph/protocol'
import type { NodeKind } from 'wdl-viewer/parser'
import { SAMPLE, slice } from './fixtures'

function node(
  kind: NodeKind,
  id: string,
  extra: { label?: string; taskName?: string | null } = {}
): SelectedNode {
  return {
    id,
    kind,
    label: extra.label ?? id,
    taskName: extra.taskName === undefined ? null : extra.taskName,
  }
}

/** What the editor would end up highlighting. */
function revealText(text: string, target: SelectedNode): string | null {
  const range = revealRange(text, target)
  return range ? slice(text, range) : null
}

describe('revealRange', () => {
  it('maps the workflow input/output nodes to the workflow’s own sections', () => {
    expect(revealText(SAMPLE, node('workflow_input', '__wf_inputs'))).toBe('input')
    expect(revealText(SAMPLE, node('workflow_output', '__wf_outputs'))).toBe('output')

    // Specifically the workflow's output — not `task align`'s, which also exists.
    const range = revealRange(SAMPLE, node('workflow_output', '__wf_outputs'))!
    const workflowStart = SAMPLE.indexOf('workflow pipeline')
    const taskStart = SAMPLE.indexOf('task align')
    expect(range.start).toBeGreaterThan(workflowStart)
    expect(range.start).toBeLessThan(taskStart)
  })

  it('maps a call node to its whole `call` header, alias included', () => {
    // The full header is highlighted rather than just the alias, so the jump
    // also shows *which* task is being called.
    expect(
      revealText(SAMPLE, node('call', 'aligned', { taskName: 'align' }))
    ).toBe('call lib.align as aligned')
    expect(revealText(SAMPLE, node('call', 'qc', { taskName: 'qc' }))).toBe('call qc')
    expect(revealText(SAMPLE, node('call', 'report', { taskName: 'report' }))).toBe('call report')
  })

  it('maps group nodes through the graph builder’s pre-order counter', () => {
    // flattenStmts visits the scatter first (counter 0), then the nested if (1).
    expect(revealText(SAMPLE, node('scatter_group', '__scatter_0'))).toBe(
      'scatter (sample in reads)'
    )
    expect(revealText(SAMPLE, node('if_group', '__if_1'))).toBe('if (depth > 20)')
  })

  it('falls back to the task name when the call id no longer matches', () => {
    // Source was edited after the graph was drawn: the alias is gone.
    expect(
      revealText(SAMPLE, node('call', 'stale', { label: 'stale', taskName: 'align' }))
    ).toBe('call lib.align as aligned')
  })

  it('falls back to the task definition when the workflow no longer calls it', () => {
    const text = 'workflow w {\n  call a\n}\n\ntask b {\n  command {\n    echo\n  }\n}\n'
    expect(revealText(text, node('call', 'b', { taskName: 'b' }))).toBe('task b')
    expect(revealText(text, node('call', 'a', { taskName: 'a' }))).toBe('call a')
  })

  it('falls back to the workflow header when a group cannot be resolved', () => {
    // Counter past the end of the document.
    expect(revealText(SAMPLE, node('if_group', '__if_9'))).toBe('workflow pipeline')
    // Counter 1 is the `if`, so claiming it is a scatter must not jump there.
    expect(revealText(SAMPLE, node('scatter_group', '__scatter_1'))).toBe('workflow pipeline')
  })

  it('resolves a scatter by its loop variable when the id shape is unknown', () => {
    expect(
      revealText(SAMPLE, node('scatter_group', 'opaque', { label: 'scatter (sample)' }))
    ).toBe('scatter (sample in reads)')
  })

  it('returns null when there is no workflow to point at', () => {
    expect(revealRange('task solo {\n  command {\n    echo\n  }\n}\n', node('call', 'solo'))).toBeNull()
    expect(revealRange('', node('workflow_input', '__wf_inputs'))).toBeNull()
  })

  it('never selects more than the header, so long blocks still centre usefully', () => {
    const range = revealRange(SAMPLE, node('call', 'aligned', { taskName: 'align' }))!
    expect(slice(SAMPLE, range)).not.toContain('input:')
    expect(SAMPLE.slice(range.end, range.end + 3)).toBe(' {\n')
  })

  it('targets the first workflow only, matching what the graph renders', () => {
    const text =
      'workflow first {\n  input {\n    Int a\n  }\n}\n\nworkflow second {\n  input {\n    Int b\n  }\n}\n'
    const range = revealRange(text, node('workflow_input', '__wf_inputs'))!
    expect(slice(text, range)).toBe('input')
    expect(range.start).toBeLessThan(text.indexOf('workflow second'))
  })
})
