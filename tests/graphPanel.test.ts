// GraphPanelManager is the glue between VS Code and the webview: panel lifecycle,
// debounced updates, and click-a-node → reveal-in-source. All of it is driven
// through tests/mocks/vscode.ts.

import { beforeEach, describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { GraphPanelManager } from '../src/graph/graphPanel'
import {
  ConfigurationTarget,
  TextEditorRevealType,
  Uri,
  ViewColumn,
  __reset,
  createTextDocument,
  fireConfigurationChange,
  fireDocumentChange,
  setConfiguration,
  window as mockWindow,
  workspace as mockWorkspace,
} from './mocks/vscode'
import type { FakeTextDocument, FakeTextEditor, FakeWebviewPanel } from './mocks/vscode'
import { fakeClock } from './fakeClock'
import type { FakeClock } from './fakeClock'
import { SAMPLE } from './fixtures'

const DEBOUNCE_MS = 300

const TEXT = [
  'version 1.0', //           0
  '', //                      1
  'workflow w {', //          2
  '  input {', //             3
  '    Int depth = 30', //    4
  '  }', //                   5
  '', //                      6
  '  scatter (i in xs) {', //  7
  '    call helper', //       8
  '  }', //                   9
  '', //                     10
  '  output {', //           11
  '    Int y = 1', //        12
  '  }', //                  13
  '}', //                    14
  '', //                     15
  'task helper {', //        16
  '  command { true }', //   17
  '}', //                    18
  '', //                     19
].join('\n')

let clock: FakeClock
let manager: GraphPanelManager
let doc: FakeTextDocument

function context(): vscode.ExtensionContext {
  return { extensionUri: Uri.file('/ext'), subscriptions: [] } as unknown as vscode.ExtensionContext
}

/** Register a document as "open" so `workspace.openTextDocument` can find it. */
function openDocument(text = TEXT, uri = '/workspace/sample.wdl'): FakeTextDocument {
  const created = createTextDocument(text, { uri })
  mockWorkspace.textDocuments.push(created)
  return created
}

/** The mock is structurally compatible but not nominally identical to the API. */
function show(document: FakeTextDocument): void {
  manager.show(document as unknown as vscode.TextDocument)
}

function panels(): FakeWebviewPanel[] {
  return mockWindow.panels
}

function lastPanel(): FakeWebviewPanel {
  return panels()[panels().length - 1]
}

interface Posted {
  type: string
  text?: string
  fileName?: string
  background?: string
}

function posted(panel: FakeWebviewPanel): Posted[] {
  return panel.webview.posted as Posted[]
}

/** Open a panel and take it to the point where the webview has said "ready". */
function readyPanel(document: FakeTextDocument = doc): FakeWebviewPanel {
  show(document)
  const panel = lastPanel()
  panel.webview.receive({ type: 'ready' })
  return panel
}

function clickNode(
  panel: FakeWebviewPanel,
  node: { id: string; kind: string; label?: string; taskName?: string | null },
  goToDefinition?: boolean
): void {
  panel.webview.receive({
    type: 'nodeSelect',
    node: { label: node.id, taskName: null, ...node },
    ...(goToDefinition === undefined ? {} : { goToDefinition }),
  })
}

/** A Ctrl/Cmd+click, as the webview posts it. */
function ctrlClickNode(
  panel: FakeWebviewPanel,
  node: { id: string; kind: string; label?: string; taskName?: string | null }
): void {
  clickNode(panel, node, true)
}

/** The text the shown editor ended up selecting. */
function selectedText(shown: { document: FakeTextDocument; editor: FakeTextEditor }): string {
  const { selection } = shown.editor
  const lines = shown.document.getText().split('\n')
  return lines[selection.start.line].slice(selection.start.character, selection.end.character)
}

/** Let the awaited reveal chain settle (real timers; the fake clock is separate). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  __reset()
  clock = fakeClock()
  manager = new GraphPanelManager(context(), clock)
  doc = openDocument()
})

describe('panel creation', () => {
  it('opens beside the editor and keeps its context when hidden', () => {
    show(doc)
    const panel = lastPanel()

    expect(panel.viewType).toBe('wdlGraph')
    expect(panel.title).toBe('WDL Graph — sample.wdl')
    expect(panel.viewColumn).toBe(ViewColumn.Beside)

    // `createWebviewPanel` takes `WebviewOptions & WebviewPanelOptions`.
    const options = panel.options as vscode.WebviewOptions & vscode.WebviewPanelOptions
    expect(options.enableScripts).toBe(true)
    expect(options.retainContextWhenHidden).toBe(true)
    expect(options.localResourceRoots?.map((root) => root.path)).toEqual(['/ext/dist'])
  })

  it('writes HTML that references all three media files with a nonce', () => {
    show(doc)
    const html = lastPanel().webview.html

    expect(html).toContain('/ext/dist/webview.js')
    expect(html).toContain('/ext/dist/webview.css')
    expect(html).toContain('/ext/dist/theme.css')
    expect(html).toContain('<script type="module" nonce="')
    expect(html).toContain("default-src 'none'")
  })

  it('uses a fresh nonce for every panel', () => {
    show(openDocument(TEXT, '/workspace/a.wdl'))
    show(openDocument(TEXT, '/workspace/b.wdl'))
    expect(panels()).toHaveLength(2)

    const nonces = panels().map((panel) => /nonce="([^"]+)"/.exec(panel.webview.html)![1])
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it('reuses the existing panel for the same document instead of opening a second', () => {
    show(doc)
    show(doc)

    expect(panels()).toHaveLength(1)
    expect(lastPanel().revealCount).toBe(1)
    expect(manager.size).toBe(1)
  })

  it('opens separate panels for separate documents', () => {
    show(doc)
    show(openDocument(TEXT, '/workspace/other.wdl'))

    expect(panels()).toHaveLength(2)
    expect(manager.size).toBe(2)
  })
})

describe('document updates', () => {
  it('says nothing until the webview reports ready', () => {
    show(doc)
    clock.advance(5000)
    expect(posted(lastPanel())).toEqual([])
  })

  it('sends the full text as `init` once the webview is ready', () => {
    const panel = readyPanel()
    expect(posted(panel)).toEqual([
      { type: 'init', text: TEXT, fileName: 'sample.wdl', background: 'auto' },
    ])
  })

  it('debounces edits by 300 ms and labels them `update`', () => {
    const panel = readyPanel()
    const edited = openDocument(TEXT + '\n')
    mockWorkspace.textDocuments[0] = edited

    fireDocumentChange(edited)
    clock.advance(DEBOUNCE_MS - 1)
    expect(posted(panel)).toHaveLength(1)

    clock.advance(1)
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1]).toEqual({
      type: 'update',
      text: TEXT + '\n',
      fileName: 'sample.wdl',
      background: 'auto',
    })
  })

  it('collapses a burst of keystrokes into one update carrying the latest text', () => {
    const panel = readyPanel()

    for (let i = 1; i <= 5; i++) {
      const edited = openDocument(TEXT + '\n'.repeat(i))
      mockWorkspace.textDocuments[0] = edited
      fireDocumentChange(edited)
      clock.advance(100)
    }
    expect(posted(panel)).toHaveLength(1)

    clock.advance(DEBOUNCE_MS)
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].text).toBe(TEXT + '\n'.repeat(5))
  })

  it('ignores edits to unrelated documents', () => {
    const panel = readyPanel()
    fireDocumentChange(openDocument('task other {\n}\n', '/workspace/other.wdl'))
    clock.advance(5000)

    expect(posted(panel)).toHaveLength(1)
  })

  it('does not post while hidden, then replays on becoming visible', () => {
    const panel = readyPanel()
    panel.setVisible(false)

    const edited = openDocument(TEXT + '\n')
    mockWorkspace.textDocuments[0] = edited
    fireDocumentChange(edited)
    clock.advance(5000)
    expect(posted(panel)).toHaveLength(1)

    panel.setVisible(true)
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1]).toEqual({
      type: 'update',
      text: TEXT + '\n',
      fileName: 'sample.wdl',
      background: 'auto',
    })
  })

  it('stops posting after the document is closed', () => {
    const panel = readyPanel()
    doc.isClosed = true

    fireDocumentChange(doc)
    clock.advance(5000)

    expect(posted(panel)).toHaveLength(1)
  })

  it('cancels a pending update when the panel is disposed', () => {
    const panel = readyPanel()
    fireDocumentChange(doc)
    expect(clock.pending()).toBe(1)

    panel.dispose()
    clock.advance(5000)

    expect(posted(panel)).toHaveLength(1)
    expect(manager.size).toBe(0)
  })
})

describe('node selection', () => {
  it('reveals and selects the matching call statement', async () => {
    const panel = readyPanel()
    clickNode(panel, { id: 'helper', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    const shown = mockWindow.shownEditors[0]
    expect(shown.document.uri.path).toBe('/workspace/sample.wdl')

    const options = shown.options as vscode.TextDocumentShowOptions
    expect(options.viewColumn).toBe(ViewColumn.One)
    // Focus stays in the graph so a run of clicks can be walked through.
    expect(options.preserveFocus).toBe(true)

    const { selection } = shown.editor
    const text = shown.document.getText()
    expect(selection.start.line).toBe(8)
    expect(selection.start.character).toBe(4)
    expect(selection.end.line).toBe(8)
    expect(selection.end.character).toBe(4 + 'call helper'.length)
    expect(
      text.split('\n')[selection.start.line].slice(selection.start.character, selection.end.character)
    ).toBe('call helper')

    expect(shown.editor.revealed).toHaveLength(1)
    expect(shown.editor.revealed[0].type).toBe(TextEditorRevealType.InCenterIfOutsideViewport)
  })

  it('reveals the workflow input block for the workflow_input node', async () => {
    const panel = readyPanel()
    clickNode(panel, { id: '__wf_inputs', kind: 'workflow_input' })
    await settle()

    const shown = mockWindow.shownEditors[0]
    expect(shown.editor.selection.start.line).toBe(3)
    expect(shown.editor.selection.start.character).toBe(2)
  })

  it('resolves a scatter group by its pre-order counter', async () => {
    const panel = readyPanel()
    clickNode(panel, { id: '__scatter_0', kind: 'scatter_group' })
    await settle()

    const shown = mockWindow.shownEditors[0]
    expect(shown.editor.selection.start.line).toBe(7)
  })

  it('ignores messages that fail the protocol guard', async () => {
    const panel = readyPanel()
    panel.webview.receive({ type: 'nodeSelect', node: { id: 'x', kind: 'not-a-kind' } })
    panel.webview.receive('nonsense')
    panel.webview.receive(null)
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
  })

  it('ignores a cleared selection', async () => {
    const panel = readyPanel()
    panel.webview.receive({ type: 'nodeSelect', node: null })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
  })

  it('does nothing when the node cannot be located', async () => {
    // `bare.wdl` has no workflow, so every node id resolves to null.
    const bare = openDocument('task lonely {\n  command { true }\n}\n', '/workspace/bare.wdl')
    const panel = readyPanel(bare)
    clickNode(panel, { id: '__wf_inputs', kind: 'workflow_input' })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
  })
})

describe('go to definition (Ctrl/Cmd+click)', () => {
  const MAIN = [
    'version 1.1', //                0
    '', //                           1
    'import "lib.wdl" as lib', //     2
    '', //                           3
    'workflow main {', //             4
    '  call lib.helper as h', //      5
    '}', //                           6
    '', //                            7
  ].join('\n')

  const LIB = [
    'version 1.1', //       0
    '', //                  1
    'task helper {', //     2
    '  command { true }', // 3
    '}', //                 4
    '', //                  5
  ].join('\n')

  it('reveals the same-file task definition instead of the call statement', async () => {
    const panel = readyPanel()
    ctrlClickNode(panel, { id: 'helper', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    const shown = mockWindow.shownEditors[0]
    expect(shown.document.uri.path).toBe('/workspace/sample.wdl')
    expect(selectedText(shown)).toBe('task helper')
    expect(shown.editor.revealed[0].type).toBe(TextEditorRevealType.InCenterIfOutsideViewport)
    expect(mockWindow.warningMessages).toEqual([])
  })

  it('opens the imported file and reveals the task there', async () => {
    openDocument(LIB, '/workspace/lib.wdl')
    const panel = readyPanel(openDocument(MAIN, '/workspace/main.wdl'))
    ctrlClickNode(panel, { id: 'h', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    const shown = mockWindow.shownEditors[0]
    expect(shown.document.uri.path).toBe('/workspace/lib.wdl')
    expect(selectedText(shown)).toBe('task helper')
    expect(mockWindow.warningMessages).toEqual([])
  })

  it('normalizes relative import paths against the importing document', async () => {
    openDocument(LIB, '/workspace/shared/lib.wdl')
    const main = MAIN.replace('"lib.wdl"', '"../shared/lib.wdl"')
    const panel = readyPanel(openDocument(main, '/workspace/sub/main.wdl'))
    ctrlClickNode(panel, { id: 'h', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    expect(mockWindow.shownEditors[0].document.uri.path).toBe('/workspace/shared/lib.wdl')
  })

  it('warns once and opens nothing when the imported file is missing', async () => {
    const panel = readyPanel(openDocument(MAIN, '/workspace/main.wdl'))
    ctrlClickNode(panel, { id: 'h', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
    expect(mockWindow.warningMessages).toEqual([
      'Cannot open "lib.wdl" imported from main.wdl',
    ])
  })

  it('warns when the namespace matches no import', async () => {
    const text = 'workflow w {\n  call nope.x\n}\n'
    const panel = readyPanel(openDocument(text, '/workspace/bad.wdl'))
    ctrlClickNode(panel, { id: 'x', kind: 'call', taskName: 'x' })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
    expect(mockWindow.warningMessages).toEqual([
      'Cannot resolve namespace "nope" — no matching import in bad.wdl',
    ])
  })

  it('warns when the imported file has no such task', async () => {
    openDocument('version 1.1\n\ntask other {\n  command { true }\n}\n', '/workspace/lib.wdl')
    const panel = readyPanel(openDocument(MAIN, '/workspace/main.wdl'))
    ctrlClickNode(panel, { id: 'h', kind: 'call', taskName: 'helper' })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
    expect(mockWindow.warningMessages).toEqual([
      'No task or workflow "helper" found in lib.wdl',
    ])
  })

  it('warns when a same-file call has no task definition', async () => {
    const text = 'workflow w {\n  call ghost\n}\n'
    const panel = readyPanel(openDocument(text, '/workspace/ghostly.wdl'))
    ctrlClickNode(panel, { id: 'ghost', kind: 'call', taskName: 'ghost' })
    await settle()

    expect(mockWindow.shownEditors).toEqual([])
    expect(mockWindow.warningMessages).toEqual([
      'No task or workflow "ghost" found in ghostly.wdl',
    ])
  })

  it('falls back to the plain reveal for non-call kinds', async () => {
    const panel = readyPanel()
    ctrlClickNode(panel, { id: '__wf_inputs', kind: 'workflow_input' })
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    // The workflow's input block (TEXT line 3), not a definition jump.
    expect(mockWindow.shownEditors[0].editor.selection.start.line).toBe(3)
    expect(mockWindow.warningMessages).toEqual([])
  })

  it('keeps revealing the call statement when goToDefinition is false', async () => {
    const panel = readyPanel()
    clickNode(panel, { id: 'helper', kind: 'call', taskName: 'helper' }, false)
    await settle()

    expect(mockWindow.shownEditors).toHaveLength(1)
    expect(selectedText(mockWindow.shownEditors[0])).toBe('call helper')
  })
})

describe('teardown', () => {
  it('disposes every panel when the manager is disposed', () => {
    show(doc)
    show(openDocument(TEXT, '/workspace/other.wdl'))
    expect(panels()).toHaveLength(2)

    manager.dispose()

    expect(panels().every((panel) => panel.disposed)).toBe(true)
    expect(manager.size).toBe(0)
  })

  it('is safe to dispose twice', () => {
    show(doc)
    manager.dispose()
    expect(() => manager.dispose()).not.toThrow()
  })

  it('stops listening for document changes after disposal', () => {
    const panel = readyPanel()
    manager.dispose()

    fireDocumentChange(doc)
    clock.advance(5000)

    expect(posted(panel)).toHaveLength(1)
  })
})

describe('payload fidelity', () => {
  it('posts the repository fixture verbatim', () => {
    const panel = readyPanel(openDocument(SAMPLE, '/workspace/example.wdl'))
    expect(posted(panel)[0]).toEqual({
      type: 'init',
      text: SAMPLE,
      fileName: 'example.wdl',
      background: 'auto',
    })
  })
})

describe('background setting', () => {
  it('sends the configured mode with every payload', () => {
    setConfiguration('wdl.viewer.background', 'light')
    const panel = readyPanel()

    expect(posted(panel)[0].background).toBe('light')
  })

  it('falls back to auto for an unexpected value', () => {
    setConfiguration('wdl.viewer.background', 'neon')
    const panel = readyPanel()

    expect(posted(panel)[0].background).toBe('auto')
  })

  it('re-posts immediately when the setting changes', () => {
    const panel = readyPanel()
    expect(posted(panel)).toHaveLength(1)

    setConfiguration('wdl.viewer.background', 'dark')
    fireConfigurationChange('wdl.viewer.background')

    // No debounce: the change is applied without waiting for the clock.
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].background).toBe('dark')
  })

  it('re-posts to every open panel', () => {
    const first = readyPanel(doc)
    const second = readyPanel(openDocument(TEXT, '/workspace/other.wdl'))

    setConfiguration('wdl.viewer.background', 'light')
    fireConfigurationChange('wdl.viewer.background')

    expect(posted(first).at(-1)!.background).toBe('light')
    expect(posted(second).at(-1)!.background).toBe('light')
  })

  it('ignores unrelated configuration changes', () => {
    const panel = readyPanel()
    fireConfigurationChange('editor.fontSize')

    expect(posted(panel)).toHaveLength(1)
  })

  it('skips hidden panels — the view-state replay picks the new value up', () => {
    const panel = readyPanel()
    panel.setVisible(false)

    setConfiguration('wdl.viewer.background', 'light')
    fireConfigurationChange('wdl.viewer.background')
    expect(posted(panel)).toHaveLength(1)

    panel.setVisible(true)
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].background).toBe('light')
  })

  it('persists a backgroundSelect from the webview as a global setting update', () => {
    const panel = readyPanel()

    panel.webview.receive({ type: 'backgroundSelect', background: 'light' })

    expect(mockWorkspace.configUpdates).toEqual([
      { key: 'wdl.viewer.background', value: 'light', target: ConfigurationTarget.Global },
    ])
  })

  it('echoes the selected mode back to the webview via the config change', () => {
    const panel = readyPanel()

    panel.webview.receive({ type: 'backgroundSelect', background: 'dark' })

    // The mock's update() fires onDidChangeConfiguration like real VS Code,
    // so the manager re-posts without any clock movement.
    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1]).toEqual({
      type: 'update',
      text: TEXT,
      fileName: 'sample.wdl',
      background: 'dark',
    })
  })

  it('propagates a webview-selected mode to every open panel', () => {
    const first = readyPanel(doc)
    const second = readyPanel(openDocument(TEXT, '/workspace/other.wdl'))

    first.webview.receive({ type: 'backgroundSelect', background: 'light' })

    expect(posted(second).at(-1)!.background).toBe('light')
  })

  it('ignores a backgroundSelect that fails the protocol guard', () => {
    const panel = readyPanel()

    panel.webview.receive({ type: 'backgroundSelect', background: 'neon' })

    expect(mockWorkspace.configUpdates).toEqual([])
    expect(posted(panel)).toHaveLength(1)
  })
})

// Every payload is the *whole document*. Over Remote-SSH that is >100 KB across
// the tunnel, competing with whatever the editor just asked the extension host
// for, so a re-post that changes nothing is worth avoiding — `show()`, the
// view-state replay and the configuration echo all used to send one unconditionally.
describe('unchanged-payload guard', () => {
  it('does not re-post when the graph is re-opened for an unchanged document', () => {
    const panel = readyPanel()
    expect(posted(panel)).toHaveLength(1)

    show(doc)

    expect(posted(panel)).toHaveLength(1)
    // The panel is still brought forward — only the payload is suppressed.
    expect(panel.revealCount).toBe(1)
  })

  it('does not re-post when a hidden panel becomes visible again unchanged', () => {
    const panel = readyPanel()

    panel.setVisible(false)
    panel.setVisible(true)

    expect(posted(panel)).toHaveLength(1)
  })

  it('does not re-post on a document change that alters nothing', () => {
    const panel = readyPanel()

    fireDocumentChange(doc)
    clock.advance(DEBOUNCE_MS)
    fireDocumentChange(doc)
    clock.advance(DEBOUNCE_MS)

    expect(posted(panel)).toHaveLength(1)
  })

  it('still posts a real edit', () => {
    const panel = readyPanel()
    const edited = openDocument(TEXT + '\n')
    mockWorkspace.textDocuments[0] = edited

    fireDocumentChange(edited)
    clock.advance(DEBOUNCE_MS)

    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].text).toBe(TEXT + '\n')

    // …and then settles again, now that the webview has that text.
    fireDocumentChange(edited)
    clock.advance(DEBOUNCE_MS)
    expect(posted(panel)).toHaveLength(2)
  })

  it('still posts a background change even though the text is untouched', () => {
    const panel = readyPanel()

    setConfiguration('wdl.viewer.background', 'dark')
    fireConfigurationChange('wdl.viewer.background')

    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].text).toBe(TEXT)
    expect(posted(panel)[1].background).toBe('dark')
  })

  it('replays an edit that was suppressed while the panel was hidden', () => {
    // The guard records what was *delivered*, not what was attempted: had the
    // hidden post marked the text as seen, this replay would wrongly skip it and
    // the graph would come back showing stale source.
    const panel = readyPanel()
    panel.setVisible(false)

    const edited = openDocument(TEXT + '\n')
    mockWorkspace.textDocuments[0] = edited
    fireDocumentChange(edited)
    clock.advance(DEBOUNCE_MS)
    expect(posted(panel)).toHaveLength(1) // suppressed while hidden

    panel.setVisible(true)

    expect(posted(panel)).toHaveLength(2)
    expect(posted(panel)[1].type).toBe('update')
    expect(posted(panel)[1].text).toBe(TEXT + '\n')
  })

  it('never suppresses a new panel’s init, even for text another panel holds', () => {
    const first = readyPanel(doc)
    const second = readyPanel(openDocument(TEXT, '/workspace/other.wdl'))

    expect(posted(first)).toHaveLength(1)
    expect(posted(second)).toHaveLength(1)
    expect(posted(second)[0].type).toBe('init')
  })
})
