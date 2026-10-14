import { describe, expect, it } from 'vitest'

import { NODE_KINDS, isHostMessage, isWebviewMessage, pickNode } from '../src/graph/protocol'
import type { HostMessage, SelectedNode, WebviewMessage } from '../src/graph/protocol'
import type { WdlNode } from 'wdl-viewer/parser'

/** A full WdlNode, as the graph builder would hand it to the webview. */
function wdlNode(overrides: Partial<WdlNode> = {}): WdlNode {
  return {
    id: 'aligned',
    kind: 'call',
    label: 'aligned',
    taskName: 'align',
    inputs: [{ name: 'reads', type: 'File', nodeId: 'aligned' }],
    outputs: [{ name: 'bam', type: 'File', nodeId: 'aligned' }],
    containedIn: '__scatter_0',
    x: 12,
    y: 34,
    width: 180,
    height: 60,
    fullHeight: 96,
    runtimeInfo: { docker: 'ubuntu:22.04' },
    command: 'echo hi',
    conditionalDepth: 1,
    ...overrides,
  }
}

describe('pickNode', () => {
  it('keeps only the four fields the host needs', () => {
    expect(pickNode(wdlNode())).toEqual({
      id: 'aligned',
      kind: 'call',
      label: 'aligned',
      taskName: 'align',
    })
  })

  it('drops coordinates, ports and runtime so the message stays small', () => {
    const picked = pickNode(wdlNode()) as unknown as Record<string, unknown>
    for (const heavy of ['x', 'y', 'width', 'height', 'fullHeight', 'inputs', 'outputs', 'runtimeInfo', 'command']) {
      expect(picked).not.toHaveProperty(heavy)
    }
  })

  it('preserves a null taskName', () => {
    expect(pickNode(wdlNode({ kind: 'if_group', id: '__if_0', taskName: null }))).toEqual({
      id: '__if_0',
      kind: 'if_group',
      label: 'aligned',
      taskName: null,
    })
  })
})

describe('NODE_KINDS', () => {
  it('lists every kind the graph builder can emit', () => {
    expect([...NODE_KINDS].sort()).toEqual(
      ['call', 'if_group', 'scatter_group', 'workflow_input', 'workflow_output'].sort()
    )
  })
})

describe('isWebviewMessage', () => {
  const valid: [string, WebviewMessage][] = [
    ['ready', { type: 'ready' }],
    ['nodeSelect with a node', { type: 'nodeSelect', node: pickNode(wdlNode()) }],
    ['nodeSelect clearing', { type: 'nodeSelect', node: null }],
    ['nodeSelect with goToDefinition', { type: 'nodeSelect', node: pickNode(wdlNode()), goToDefinition: true }],
    ['nodeSelect with goToDefinition false', { type: 'nodeSelect', node: pickNode(wdlNode()), goToDefinition: false }],
    ['nodeSelect clearing with goToDefinition', { type: 'nodeSelect', node: null, goToDefinition: false }],
    ['parseError', { type: 'parseError', errors: ['unexpected token'] }],
    ['parseError empty', { type: 'parseError', errors: [] }],
    ['backgroundSelect', { type: 'backgroundSelect', background: 'light' }],
  ]

  it.each(valid)('accepts %s', (_label, message) => {
    expect(isWebviewMessage(message)).toBe(true)
  })

  const invalid: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ready'],
    ['a number', 42],
    ['an array', []],
    ['no type', { ready: true }],
    ['unknown type', { type: 'explode' }],
    ['nodeSelect without node key', { type: 'nodeSelect' }],
    ['nodeSelect with a non-object node', { type: 'nodeSelect', node: 'aligned' }],
    ['node with a bad kind', { type: 'nodeSelect', node: { id: 'a', kind: 'nope', label: 'a', taskName: null } }],
    ['node without an id', { type: 'nodeSelect', node: { kind: 'call', label: 'a', taskName: null } }],
    ['node with a numeric taskName', { type: 'nodeSelect', node: { id: 'a', kind: 'call', label: 'a', taskName: 7 } }],
    ['nodeSelect with a numeric goToDefinition', { type: 'nodeSelect', node: pickNode(wdlNode()), goToDefinition: 1 }],
    ['nodeSelect with a string goToDefinition', { type: 'nodeSelect', node: pickNode(wdlNode()), goToDefinition: 'yes' }],
    ['parseError with a non-array', { type: 'parseError', errors: 'boom' }],
    ['parseError with non-string entries', { type: 'parseError', errors: [1, 2] }],
    ['backgroundSelect without background', { type: 'backgroundSelect' }],
    ['backgroundSelect with an unknown mode', { type: 'backgroundSelect', background: 'neon' }],
  ]

  it.each(invalid)('rejects %s', (_label, value) => {
    expect(isWebviewMessage(value)).toBe(false)
  })

  it('narrows the payload for the compiler', () => {
    const raw: unknown = { type: 'nodeSelect', node: pickNode(wdlNode()) }
    if (!isWebviewMessage(raw)) throw new Error('unreachable')
    // Reached only because the guard proved the shape.
    if (raw.type === 'nodeSelect' && raw.node) {
      const node: SelectedNode = raw.node
      expect(node.taskName).toBe('align')
    } else {
      throw new Error('unreachable')
    }
  })
})

describe('isHostMessage', () => {
  it.each([
    ['init', { type: 'init', text: 'version 1.0', fileName: 'a.wdl', background: 'auto' }],
    ['update', { type: 'update', text: '', fileName: '', background: 'light' }],
    ['dark background', { type: 'init', text: '', fileName: '', background: 'dark' }],
  ])('accepts %s', (_label, message) => {
    expect(isHostMessage(message)).toBe(true)
  })

  it.each([
    ['null', null],
    ['a webview message', { type: 'ready' }],
    ['init without text', { type: 'init', fileName: 'a.wdl', background: 'auto' }],
    ['update without fileName', { type: 'update', text: '', background: 'auto' }],
    ['update without background', { type: 'update', text: '', fileName: 'a.wdl' }],
    ['update with an unknown background', { type: 'update', text: '', fileName: 'a.wdl', background: 'neon' }],
    ['update with a non-string text', { type: 'update', text: 5, fileName: 'a.wdl', background: 'auto' }],
    ['unknown type', { type: 'reload', text: '', fileName: '', background: 'auto' }],
  ])('rejects %s', (_label, value) => {
    expect(isHostMessage(value)).toBe(false)
  })

  it('narrows to the shared payload shape', () => {
    const raw: unknown = { type: 'init', text: 'version 1.0', fileName: 'a.wdl', background: 'auto' }
    if (!isHostMessage(raw)) throw new Error('unreachable')
    const message: HostMessage = raw
    expect(message.text).toBe('version 1.0')
    expect(message.background).toBe('auto')
  })
})
