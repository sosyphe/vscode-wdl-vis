// Extension entry point: registers the language providers and the graph command.
//
// `activationEvents` is empty in package.json — VS Code infers `onLanguage:wdl`
// and `onCommand:wdl.openGraph` from `contributes`, so nothing is listed twice
// here and nothing loads until a `.wdl` file is actually touched.
//
// This is also where the two pieces of shared state are created and handed out:
//
//   • one `ScanCache`, so a single document scan serves the definition, symbol
//     and folding providers instead of each of them re-scanning. They are called
//     constantly and independently — symbols on every cursor move, because
//     breadcrumbs track the caret — so the sharing is where most of the win is.
//   • one `Tracer`, off unless `wdl.viewer.trace` is set, which is how the
//     remaining latency gets attributed. See tracer.ts for why that
//     matters: the scan itself measures in single-digit milliseconds, so a
//     multi-second Ctrl+click is not obviously ours to fix.

import * as vscode from 'vscode'

import { GraphPanelManager } from './graph/graphPanel'
import { WdlOutlineProvider } from './providers/outlineProvider'
import { WdlFoldProvider } from './providers/foldProvider'
import { WdlDefinitionProvider } from './providers/definitionProvider'
import { ScanCache } from './language/scanCache'
import { Tracer } from './util/tracer'

const SELECTOR: vscode.DocumentSelector = { language: 'wdl' }

/** Setting id for in-situ tracing; see `contributes.configuration`. */
const TRACE_CONFIG = 'wdl.viewer.trace'

export function activate(context: vscode.ExtensionContext): void {
  const startedAt = Date.now()

  const cache = new ScanCache()

  const tracer = new Tracer({
    // Read live, so flipping the setting takes effect without a reload.
    enabled: () =>
      vscode.workspace.getConfiguration('wdl.viewer').get<boolean>('trace', false),
    // Lazy: with tracing off — the default — no channel is ever created.
    createChannel: () => {
      const channel = vscode.window.createOutputChannel('WDL Viewer')
      return {
        appendLine: (line: string) => channel.appendLine(line),
        show: () => channel.show(true),
        dispose: () => channel.dispose(),
      }
    },
  })
  tracer.refresh() // arms the event-loop lag probe when tracing is already on
  tracer.setActivationMs(Date.now() - startedAt)

  // `undefined` for the timer keeps GraphPanelManager's real-clock default.
  const graphs = new GraphPanelManager(context, undefined, cache, tracer)

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      SELECTOR,
      new WdlOutlineProvider(cache),
      // Shown as the provider label in the breadcrumb symbol picker.
      { label: 'WDL' }
    ),
    vscode.languages.registerFoldingRangeProvider(SELECTOR, new WdlFoldProvider(cache)),
    vscode.languages.registerDefinitionProvider(
      SELECTOR,
      new WdlDefinitionProvider(cache, tracer)
    ),
    vscode.commands.registerCommand('wdl.openGraph', () => openGraph(graphs)),
    vscode.commands.registerCommand('wdl.showDiagnostics', () => showDiagnostics(tracer, cache)),

    // A closed document will not be scanned again; drop it rather than let it
    // sit in the LRU until it is evicted.
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.invalidate(document.uri.toString())
    }),

    // Tracing can be switched on mid-session, which is the whole point — the
    // lag probe has to start listening before the slowness happens.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(TRACE_CONFIG)) {
        tracer.refresh()
        tracer.note(`trace ${tracer.isEnabled ? 'enabled' : 'disabled'}`)
      }
    }),

    graphs,
    tracer
  )
}

export function deactivate(): void {
  // `GraphPanelManager` and the `Tracer` are pushed onto
  // `context.subscriptions`, so VS Code disposes them — every panel, listener,
  // pending debounce, lag probe and output channel — on shutdown.
}

function showDiagnostics(tracer: Tracer, cache: ScanCache): void {
  const stats = cache.stats
  tracer.showSummary([
    '',
    `scan cache:      ${stats.hits} hit(s), ${stats.misses} miss(es), ` +
      `${stats.size} document(s) held`,
  ])
}

function openGraph(graphs: GraphPanelManager): void {
  const document = activeWdlDocument()

  if (!document) {
    void vscode.window.showInformationMessage('Open a WDL file to view its workflow graph.')
    return
  }

  graphs.show(document)
}

/**
 * The active editor when it holds WDL, otherwise any visible WDL editor — the
 * command is also reachable from the palette while focus sits in the terminal or
 * in the graph webview itself.
 */
function activeWdlDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor
  if (active && active.document.languageId === 'wdl') return active.document

  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.languageId === 'wdl'
  )?.document
}
