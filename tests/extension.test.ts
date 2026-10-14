// Covers the entry point itself: what `activate` registers, and how the
// `wdl.openGraph` command picks the document to graph.

import { beforeEach, describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { activate, deactivate } from '../src/extension'
import {
  Uri,
  __reset,
  commands as mockCommands,
  createTextDocument,
  createTextEditor,
  languages as mockLanguages,
  window as mockWindow,
  workspace as mockWorkspace,
} from './mocks/vscode'
import type { FakeTextDocument, FakeTextEditor } from './mocks/vscode'

const WDL = 'version 1.0\n\nworkflow w {\n  call t\n}\n\ntask t {\n  command { true }\n}\n'

let context: vscode.ExtensionContext

function wdlDocument(uri = '/workspace/sample.wdl', text = WDL): FakeTextDocument {
  const created = createTextDocument(text, { uri })
  mockWorkspace.textDocuments.push(created)
  return created
}

function asEditor(document: FakeTextDocument): FakeTextEditor {
  return createTextEditor(document)
}

function asDocument(document: FakeTextDocument): vscode.TextDocument {
  return document as unknown as vscode.TextDocument
}

function openGraph(): Promise<void> {
  return mockCommands.executeCommand('wdl.openGraph') as Promise<void>
}

beforeEach(() => {
  __reset()
  context = {
    extensionUri: Uri.file('/ext'),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext

  // No document-change events are fired here, so the manager's real 300 ms
  // debounce never arms and no test has to wait on it.
  activate(context)
})

describe('activate', () => {
  it('registers the graph command', () => {
    expect(mockCommands.handlers.has('wdl.openGraph')).toBe(true)
  })

  it('registers symbol, folding and definition providers for WDL only', () => {
    expect(mockLanguages.registered).toHaveLength(3)
    for (const entry of mockLanguages.registered) {
      expect(entry.selector).toEqual({ language: 'wdl' })
    }
    const [symbols, folding, definitions] = mockLanguages.registered
    expect(typeof (symbols.provider as vscode.DocumentSymbolProvider).provideDocumentSymbols).toBe(
      'function'
    )
    expect(typeof (folding.provider as vscode.FoldingRangeProvider).provideFoldingRanges).toBe(
      'function'
    )
    expect(typeof (definitions.provider as vscode.DefinitionProvider).provideDefinition).toBe(
      'function'
    )
  })

  it('labels the symbol provider so the breadcrumb picker shows a name', () => {
    const metadata = mockLanguages.registered[0].metadata as vscode.DocumentSymbolProviderMetadata
    expect(metadata.label).toBe('WDL')
  })

  it('pushes its disposables onto the extension context', () => {
    // Three providers + two commands (`wdl.openGraph`, `wdl.showDiagnostics`)
    // + two workspace listeners (cache invalidation on close, trace setting
    // change) + the panel manager + the tracer.
    expect(context.subscriptions).toHaveLength(9)
    for (const disposable of context.subscriptions) {
      expect(typeof disposable.dispose).toBe('function')
    }
  })

  it('wires providers that actually return symbols and folds', () => {
    const document = asDocument(wdlDocument())
    const token = {} as vscode.CancellationToken

    const symbols = (
      mockLanguages.registered[0].provider as vscode.DocumentSymbolProvider
    ).provideDocumentSymbols(document, token) as vscode.DocumentSymbol[]
    expect(symbols.map((symbol) => symbol.name)).toEqual(['w', 't'])

    const folds = (
      mockLanguages.registered[1].provider as vscode.FoldingRangeProvider
    ).provideFoldingRanges(
      document,
      { includeIndentation: false } as vscode.FoldingContext,
      token
    ) as vscode.FoldingRange[]
    // Lines: 2–4 workflow, 6–8 task. The bare `call t` and the single-line
    // `command { true }` contribute nothing.
    expect(folds.map((fold) => [fold.start, fold.end])).toEqual([
      [2, 4],
      [6, 8],
    ])
  })
})

describe('wdl.openGraph', () => {
  it('opens a panel for the active WDL document', async () => {
    const document = wdlDocument()
    mockWindow.activeTextEditor = asEditor(document)

    await openGraph()

    expect(mockWindow.panels).toHaveLength(1)
    expect(mockWindow.panels[0].title).toBe('WDL Graph — sample.wdl')
    expect(mockWindow.informationMessages).toEqual([])
  })

  it('explains what to do when no WDL file is open', async () => {
    mockWindow.activeTextEditor = undefined
    mockWindow.visibleTextEditors = []

    await openGraph()

    expect(mockWindow.panels).toEqual([])
    expect(mockWindow.informationMessages).toEqual([
      'Open a WDL file to view its workflow graph.',
    ])
  })

  it('ignores an active editor that is not WDL', async () => {
    const readme = createTextDocument('# hello\n', {
      uri: '/workspace/README.md',
      languageId: 'markdown',
    })
    mockWindow.activeTextEditor = asEditor(readme)
    mockWindow.visibleTextEditors = []

    await openGraph()

    expect(mockWindow.panels).toEqual([])
    expect(mockWindow.informationMessages).toHaveLength(1)
  })

  it('falls back to a visible WDL editor when focus is elsewhere', async () => {
    const document = wdlDocument('/workspace/other.wdl')
    const readme = createTextDocument('# hello\n', {
      uri: '/workspace/README.md',
      languageId: 'markdown',
    })

    mockWindow.activeTextEditor = asEditor(readme)
    mockWindow.visibleTextEditors = [asEditor(document)]

    await openGraph()

    expect(mockWindow.panels).toHaveLength(1)
    expect(mockWindow.panels[0].title).toBe('WDL Graph — other.wdl')
  })

  it('reuses the panel on a second invocation', async () => {
    const document = wdlDocument()
    mockWindow.activeTextEditor = asEditor(document)

    await openGraph()
    await openGraph()

    expect(mockWindow.panels).toHaveLength(1)
    expect(mockWindow.panels[0].revealCount).toBe(1)
  })
})

describe('deactivate', () => {
  it('is a no-op — VS Code disposes context.subscriptions', () => {
    expect(() => deactivate()).not.toThrow()
  })

  it('leaves the registered disposables intact for VS Code to release', () => {
    deactivate()
    expect(context.subscriptions).toHaveLength(9)
    for (const disposable of context.subscriptions) {
      expect(() => disposable.dispose()).not.toThrow()
    }
    expect(mockCommands.handlers.size).toBe(0)
  })
})
