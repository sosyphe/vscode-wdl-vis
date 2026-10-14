// resolveCallDefinition maps a clicked call node to where its task/workflow is
// defined; resolveQualified is the namespace/import half shared with the editor
// DefinitionProvider; findCallAtOffset is the cursor hit-test for that provider;
// definitionRange locates the block in the target text. All pure — the
// vscode-dependent URI resolution is covered in graphPanel.test.ts and
// definitionProvider.test.ts.

import { describe, expect, it } from 'vitest'

import {
  resolveCallDefinition,
  resolveQualified,
  findCallAtOffset,
  definitionRange,
} from '../src/language/definition'
import { scanDocument } from '../src/language/scanner'
import type { SelectedNode } from '../src/graph/protocol'
import { SAMPLE, slice } from './fixtures'

function callNode(overrides: Partial<SelectedNode> = {}): SelectedNode {
  return { id: 'helper', kind: 'call', label: 'helper', taskName: 'helper', ...overrides }
}

const LOCAL = [
  'version 1.0',
  '',
  'workflow w {',
  '  call helper',
  '  call sub',
  '}',
  '',
  'task helper {',
  '  command { true }',
  '}',
  '',
  'workflow sub {',
  '  call helper',
  '}',
  '',
].join('\n')

describe('resolveCallDefinition', () => {
  it('resolves an unqualified call to a same-file task', () => {
    expect(resolveCallDefinition(LOCAL, callNode())).toEqual({
      type: 'same-file',
      taskName: 'helper',
    })
  })

  it('resolves an unqualified call to a same-file sub-workflow', () => {
    expect(resolveCallDefinition(LOCAL, callNode({ id: 'sub', taskName: 'sub' }))).toEqual({
      type: 'same-file',
      taskName: 'sub',
    })
  })

  it('recovers the qualified target through an alias from the repository fixture', () => {
    // The graph only carries the short name; `lib.align as aligned` must be
    // recovered from the scanned call block to find the namespace.
    const node = callNode({ id: 'aligned', label: 'aligned', taskName: 'align' })
    expect(resolveCallDefinition(SAMPLE, node)).toEqual({
      type: 'imported',
      importPath: 'lib.wdl',
      namespace: 'lib',
      taskName: 'align',
    })
  })

  it('resolves a bare qualified call against an explicit alias', () => {
    const text = 'import "tasks/align.wdl" as aligner\nworkflow w { call aligner.go }\n'
    expect(resolveCallDefinition(text, callNode({ id: 'go', taskName: 'go' }))).toEqual({
      type: 'imported',
      importPath: 'tasks/align.wdl',
      namespace: 'aligner',
      taskName: 'go',
    })
  })

  it('uses the file stem as the namespace when the import has no alias', () => {
    const text = 'import "tools.wdl"\nworkflow w { call tools.x }\n'
    expect(resolveCallDefinition(text, callNode({ id: 'x', taskName: 'x' }))).toEqual({
      type: 'imported',
      importPath: 'tools.wdl',
      namespace: 'tools',
      taskName: 'x',
    })
  })

  it('prefers an explicit alias over another import\'s default alias, whatever the order', () => {
    const text = [
      'import "tools.wdl"', // default alias would also be `tools` (invalid WDL)
      'import "lib.wdl" as tools', // explicit `tools` wins
      'workflow w { call tools.x }',
      '',
    ].join('\n')
    expect(resolveCallDefinition(text, callNode({ id: 'x', taskName: 'x' }))).toEqual({
      type: 'imported',
      importPath: 'lib.wdl',
      namespace: 'tools',
      taskName: 'x',
    })
  })

  it('reports an unknown namespace', () => {
    const text = 'import "lib.wdl" as lib\nworkflow w { call nope.x }\n'
    expect(resolveCallDefinition(text, callNode({ id: 'x', taskName: 'x' }))).toEqual({
      type: 'unresolved',
      reason: 'unknown-namespace',
      detail: 'nope',
      taskName: 'x',
    })
  })

  it('reports a multi-dot target as an unknown namespace — aliases cannot contain dots', () => {
    const text = 'import "a.wdl" as a\nworkflow w { call a.b.c }\n'
    const resolved = resolveCallDefinition(text, callNode({ id: 'c', taskName: 'c' }))
    expect(resolved).toMatchObject({ type: 'unresolved', reason: 'unknown-namespace' })
  })

  it('reports a remote import', () => {
    const text = 'import "https://example.com/tools.wdl" as tools\nworkflow w { call tools.x }\n'
    expect(resolveCallDefinition(text, callNode({ id: 'x', taskName: 'x' }))).toEqual({
      type: 'unresolved',
      reason: 'remote-import',
      detail: 'https://example.com/tools.wdl',
      taskName: 'x',
    })
  })

  it('falls back to the short name when the call block is gone (stale graph)', () => {
    // The source no longer contains any call — only the graph's taskName survives.
    const text = 'workflow w {\n}\n\ntask helper {\n  command { true }\n}\n'
    expect(resolveCallDefinition(text, callNode({ id: 'ghost' }))).toEqual({
      type: 'same-file',
      taskName: 'helper',
    })
  })

  it('reports no-target when neither the call block nor a taskName exists', () => {
    expect(resolveCallDefinition(LOCAL, callNode({ id: 'ghost', taskName: null }))).toEqual({
      type: 'unresolved',
      reason: 'no-target',
      detail: '',
      taskName: null,
    })
  })
})

describe('resolveQualified', () => {
  // Smokes only — the namespace rules are covered in depth through
  // resolveCallDefinition above; this pins the shared entry point the editor
  // DefinitionProvider uses.
  const resolve = (text: string, qualified: string) =>
    resolveQualified(text, scanDocument(text), qualified)

  it('resolves an unqualified target to the same file', () => {
    expect(resolve(LOCAL, 'helper')).toEqual({ type: 'same-file', taskName: 'helper' })
  })

  it('resolves a qualified target through an explicit import alias', () => {
    expect(resolve(SAMPLE, 'lib.align')).toEqual({
      type: 'imported',
      importPath: 'lib.wdl',
      namespace: 'lib',
      taskName: 'align',
    })
  })

  it('reports an unknown namespace', () => {
    expect(resolve(SAMPLE, 'nope.x')).toMatchObject({
      type: 'unresolved',
      reason: 'unknown-namespace',
      detail: 'nope',
    })
  })

  it('reports a remote import', () => {
    const text = 'import "https://example.com/tools.wdl" as tools\nworkflow w { call tools.x }\n'
    expect(resolve(text, 'tools.x')).toMatchObject({
      type: 'unresolved',
      reason: 'remote-import',
    })
  })
})

describe('findCallAtOffset', () => {
  const find = (text: string, offset: number) =>
    findCallAtOffset(text, scanDocument(text), offset)

  // Offsets into the repository fixture's `call lib.align as aligned` (nested
  // in scatter + if), computed from indexOf so they survive fixture edits
  // above the call.
  const targetStart = SAMPLE.indexOf('lib.align')
  const aliasStart = SAMPLE.indexOf('as aligned') + 'as '.length

  it('hits the qualified target name, including the namespace part', () => {
    expect(find(SAMPLE, targetStart + 1)?.name).toBe('lib.align') // inside `lib.`
    expect(find(SAMPLE, targetStart + 5)?.name).toBe('lib.align') // inside `align`
  })

  it('hits the inclusive start and end edges of the target name', () => {
    expect(find(SAMPLE, targetStart)?.name).toBe('lib.align')
    expect(find(SAMPLE, targetStart + 'lib.align'.length)?.name).toBe('lib.align')
  })

  it('hits the alias of an aliased call', () => {
    // nameStart/nameEnd store the ALIAS span — clicking either name of the
    // call must reach the definition.
    expect(find(SAMPLE, aliasStart + 2)?.alias).toBe('aligned')
    expect(find(SAMPLE, aliasStart + 'aligned'.length)?.alias).toBe('aligned') // end-inclusive
  })

  it('hits a bare call with no argument list', () => {
    const offset = SAMPLE.indexOf('call report') + 'call '.length + 1
    const block = find(SAMPLE, offset)
    expect(block?.name).toBe('report')
    expect(block?.alias).toBeNull()
  })

  it('misses the call keyword itself', () => {
    expect(find(SAMPLE, SAMPLE.indexOf('call lib.align') + 1)).toBeNull()
  })

  it('misses the call input body', () => {
    expect(find(SAMPLE, SAMPLE.indexOf('reads = sample') + 2)).toBeNull()
  })

  it('misses task headers, import lines and struct names', () => {
    expect(find(SAMPLE, SAMPLE.indexOf('task align') + 6)).toBeNull()
    expect(find(SAMPLE, SAMPLE.indexOf('import "lib.wdl"') + 9)).toBeNull()
    expect(find(SAMPLE, SAMPLE.indexOf('struct Config') + 8)).toBeNull()
  })

  it('misses comments, even ones mentioning a call', () => {
    const text = 'workflow w {\n  # call helper is planned\n  call helper\n}\n\ntask helper {\n  command { true }\n}\n'
    expect(find(text, text.indexOf('# call helper') + 2)).toBeNull()
    expect(find(text, text.indexOf('  call helper\n') + 8)?.name).toBe('helper')
  })
})

describe('definitionRange', () => {
  it('finds a task and selects only its header', () => {
    const range = definitionRange(LOCAL, 'helper')
    expect(range).not.toBeNull()
    expect(slice(LOCAL, range!)).toBe('task helper')
  })

  it('finds a workflow definition (imported sub-workflow call)', () => {
    const range = definitionRange(LOCAL, 'sub')
    expect(range).not.toBeNull()
    expect(slice(LOCAL, range!)).toBe('workflow sub')
  })

  it('returns the first definition in document order', () => {
    const range = definitionRange(SAMPLE, 'align')
    expect(slice(SAMPLE, range!)).toBe('task align')
  })

  it('returns null when the name is not defined', () => {
    expect(definitionRange(LOCAL, 'missing')).toBeNull()
  })
})
