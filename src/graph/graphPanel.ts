// Owns the graph webviews: one panel per document, created on demand, kept alive
// while hidden so zoom/pan state survives tab switches.
//
// Edits are pushed through a 300 ms trailing debounce. The webview never
// re-mounts — it reassigns a ref, so `WdlViewer`'s internal
// `computed(() => parseWdl(...))` re-runs and the layout updates in place.

import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'

import { buildWebviewHtml } from './webviewHtml'
import { debounce, defaultTimer } from '../util/debounce'
import type { Debounced, Timer } from '../util/debounce'
import { BACKGROUNDS, isWebviewMessage } from './protocol'
import type { Background, HostMessage, SelectedNode } from './protocol'
import { revealRange } from '../language/reveal'
import { resolveCallDefinition, definitionRange } from '../language/definition'
import { resolveImportPath, hasUriScheme } from '../language/imports'
import { ScanCache } from '../language/scanCache'
import { nullTracer } from '../util/tracer'
import type { Tracer } from '../util/tracer'
import type { ScannedBlock } from '../language/scanner'
import type { OffsetRange } from '../language/outline'

/** Long enough to coalesce a burst of keystrokes, short enough to feel live. */
const UPDATE_DEBOUNCE_MS = 300

/** Setting id for the graph background mode; see `contributes.configuration`. */
const BACKGROUND_CONFIG = 'wdl.viewer.background'

/** Current `wdl.viewer.background` value; anything unexpected falls back to auto. */
function configuredBackground(): Background {
  const value = vscode.workspace.getConfiguration('wdl.viewer').get<string>('background', 'auto')
  return BACKGROUNDS.includes(value as Background) ? (value as Background) : 'auto'
}

interface GraphPanel {
  panel: vscode.WebviewPanel
  uri: vscode.Uri
  /** Refreshed from every change event; may become closed, which is guarded for. */
  document: vscode.TextDocument
  /** Whether the webview has announced itself and can receive payloads. */
  ready: boolean
  /** Whether a payload has been delivered — the first is `init`, the rest `update`. */
  sent: boolean
  /**
   * What the webview was last *actually* sent, for the no-op guard in `post()`.
   *
   * Written only after `postMessage` runs, never before: a payload skipped
   * because the panel was hidden did not reach the webview, and recording it
   * would make the replay on `onDidChangeViewState` think there was nothing to
   * catch up on.
   */
  lastText: string | null
  lastBackground: Background | null
  disposables: vscode.Disposable[]
  pushUpdate: Debounced<[]>
}

function baseName(uri: vscode.Uri): string {
  const segments = uri.path.split('/')
  return segments[segments.length - 1] || uri.path
}

function warn(message: string): void {
  void vscode.window.showWarningMessage(message)
}

export class GraphPanelManager {
  private readonly panels = new Map<string, GraphPanel>()
  private readonly mediaRoot: vscode.Uri
  private readonly timer: Timer
  private readonly cache: ScanCache
  private readonly tracer: Tracer
  private readonly own: vscode.Disposable[] = []

  /**
   * `cache` and `tracer` are appended after `timer` and both default, so
   * existing construction sites — `new GraphPanelManager(context, fakeClock)` in
   * the tests — are unaffected. `activate()` passes the instances it shares with
   * the language providers, so a graph-side click reuses the scan the editor
   * already paid for.
   */
  constructor(
    context: vscode.ExtensionContext,
    timer: Timer = defaultTimer,
    cache: ScanCache = new ScanCache(),
    tracer: Tracer = nullTracer
  ) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'dist')
    this.timer = timer
    this.cache = cache
    this.tracer = tracer

    // One global listener for every open panel, keyed by document URI.
    this.own.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const entry = this.panels.get(event.document.uri.toString())
        if (!entry) return
        entry.document = event.document
        entry.pushUpdate()
      }),

      // Background mode is re-read on every `post()`, so a settings change only
      // needs to re-push each live panel immediately (bypassing the debounce).
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(BACKGROUND_CONFIG)) return
        for (const entry of this.panels.values()) {
          entry.pushUpdate.cancel()
          this.post(entry)
        }
      })
    )
  }

  /** Number of live panels. Exposed for tests and `deactivate`. */
  get size(): number {
    return this.panels.size
  }

  /** Open the graph for `document`, or bring the existing panel forward. */
  show(document: vscode.TextDocument): void {
    const key = document.uri.toString()
    const existing = this.panels.get(key)

    if (existing) {
      existing.document = document
      existing.panel.reveal(existing.panel.viewColumn, true)
      // A pending debounce may hold text that is already stale.
      existing.pushUpdate.cancel()
      this.post(existing)
      return
    }

    this.create(document, key)
  }

  /** Tear down every panel and listener. Safe to call twice. */
  dispose(): void {
    for (const disposable of this.own.splice(0)) disposable.dispose()
    for (const entry of [...this.panels.values()]) entry.panel.dispose()
    this.panels.clear()
  }

  private create(document: vscode.TextDocument, key: string): void {
    const name = baseName(document.uri)
    const panel = vscode.window.createWebviewPanel(
      'wdlGraph',
      `WDL Graph — ${name}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // Without this, switching tabs destroys the Vue app and resets the viewport.
        retainContextWhenHidden: true,
        localResourceRoots: [this.mediaRoot],
      }
    )

    const entry: GraphPanel = {
      panel,
      uri: document.uri,
      document,
      ready: false,
      sent: false,
      lastText: null,
      lastBackground: null,
      disposables: [],
      pushUpdate: debounce(() => this.post(entry), UPDATE_DEBOUNCE_MS, this.timer),
    }
    this.panels.set(key, entry)

    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      // Fresh token per render; a stale nonce would silently block the bundle.
      nonce: randomUUID(),
      title: `WDL Graph — ${name}`,
      resources: {
        script: vscode.Uri.joinPath(this.mediaRoot, 'webview.js'),
        libraryCss: vscode.Uri.joinPath(this.mediaRoot, 'webview.css'),
        themeCss: vscode.Uri.joinPath(this.mediaRoot, 'theme.css'),
      },
    })

    entry.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(entry, raw)),

      // `retainContextWhenHidden` keeps the app alive, so a payload skipped while
      // hidden has to be replayed when the tab comes back.
      panel.onDidChangeViewState(() => {
        if (!panel.visible) return
        entry.pushUpdate.cancel()
        this.post(entry)
      }),

      panel.onDidDispose(() => {
        entry.pushUpdate.cancel()
        for (const disposable of entry.disposables.splice(0)) disposable.dispose()
        this.panels.delete(key)
      })
    )
  }

  private onMessage(entry: GraphPanel, raw: unknown): void {
    if (!isWebviewMessage(raw)) return

    switch (raw.type) {
      case 'ready':
        entry.ready = true
        this.post(entry)
        break

      case 'nodeSelect':
        if (!raw.node) break
        // Ctrl/Cmd+click on a call jumps to the task definition; everything
        // else (including flagged non-call kinds) keeps the plain reveal.
        if (raw.goToDefinition && raw.node.kind === 'call') {
          void this.revealTaskDefinition(entry, raw.node)
        } else {
          void this.revealInSource(entry, raw.node)
        }
        break

      case 'parseError':
        // The banner is rendered inside the webview; there is no Problems-panel
        // diagnostic to file (deliberately out of scope).
        break

      case 'backgroundSelect':
        // Write through to the setting (globally, so the choice outlives the
        // panel). The resulting configuration-change event re-posts every live
        // panel — the webview never applies a mode the host hasn't confirmed.
        void vscode.workspace
          .getConfiguration('wdl.viewer')
          .update('background', raw.background, vscode.ConfigurationTarget.Global)
        break
    }
  }

  private post(entry: GraphPanel): void {
    if (!entry.ready) return // the webview is not listening yet
    if (entry.document.isClosed) return
    if (!entry.panel.visible) return // replayed by onDidChangeViewState

    const text = entry.document.getText()
    const background = configuredBackground()

    // Nothing has changed since the last payload that actually reached the
    // webview. This is the guard that stops `show()`, `onDidChangeViewState`
    // and `onDidChangeConfiguration` from each re-shipping the whole document:
    // over Remote-SSH that is a >100 KB string across the tunnel on every tab
    // switch back to the graph, queued ahead of whatever the editor just asked
    // the extension host for. It sits *after* the three early returns so that
    // `init` is never suppressed and a payload skipped while hidden is still
    // replayed when the panel comes back.
    if (entry.sent && text === entry.lastText && background === entry.lastBackground) {
      this.tracer.note(`post skipped, unchanged (${text.length} chars) — ${baseName(entry.uri)}`)
      return
    }

    const message: HostMessage = {
      type: entry.sent ? 'update' : 'init',
      text,
      fileName: baseName(entry.uri),
      background,
    }
    entry.sent = true
    // Recorded only once the message is on its way — see `lastText` on GraphPanel.
    entry.lastText = text
    entry.lastBackground = background
    void entry.panel.webview.postMessage(message)
    this.tracer.note(`post sent ${text.length} chars — ${baseName(entry.uri)}`)
  }

  /** `openTextDocument` rejects for missing/deleted files — degrade to null. */
  private async openDocumentQuietly(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
    try {
      return await vscode.workspace.openTextDocument(uri)
    } catch {
      return null
    }
  }

  private async revealInSource(entry: GraphPanel, node: SelectedNode): Promise<void> {
    // Re-open through the URI rather than trusting `entry.document`: the tab may
    // have been closed since the graph was drawn.
    const document = await this.openDocumentQuietly(entry.uri)
    if (!document) return
    const text = document.getText()
    const blocks = this.scanned(document, text)
    const range = revealRange(text, node, blocks)
    if (!range) return
    await this.revealRangeInDocument(document, range)
  }

  /** The document's blocks, through the cache shared with the language providers. */
  private scanned(document: vscode.TextDocument, text: string): ScannedBlock[] {
    return this.cache.blocksFor(document.uri.toString(), document.version, text)
  }

  /** Ctrl/Cmd+click on a call node: reveal the task/workflow it calls. */
  private async revealTaskDefinition(entry: GraphPanel, node: SelectedNode): Promise<void> {
    const document = await this.openDocumentQuietly(entry.uri)
    if (!document) return

    const sourceName = baseName(entry.uri)
    const text = document.getText()
    // One scan, reused by both the resolution below and `definitionRange` —
    // this path used to scan the same document twice per click, exactly as the
    // editor's provider did.
    const blocks = this.scanned(document, text)
    const resolution = resolveCallDefinition(text, node, blocks)

    if (resolution.type === 'unresolved') {
      switch (resolution.reason) {
        case 'unknown-namespace':
          warn(`Cannot resolve namespace "${resolution.detail}" — no matching import in ${sourceName}`)
          return
        case 'remote-import':
          warn(`Cannot open remote import "${resolution.detail}"`)
          return
        case 'no-target':
          warn('Cannot determine the task for this call')
          return
      }
    }

    if (resolution.type === 'same-file') {
      const range = definitionRange(text, resolution.taskName, blocks)
      if (!range) {
        warn(`No task or workflow "${resolution.taskName}" found in ${sourceName}`)
        return
      }
      await this.revealRangeInDocument(document, range)
      return
    }

    // Imported: resolve the path against this document and open the target.
    const targetUri = this.resolveImportUri(entry.uri, resolution.importPath)
    if (!targetUri) {
      warn(`Cannot open remote import "${resolution.importPath}"`)
      return
    }
    const targetDocument = await this.openDocumentQuietly(targetUri)
    if (!targetDocument) {
      warn(`Cannot open "${resolution.importPath}" imported from ${sourceName}`)
      return
    }
    const targetText = targetDocument.getText()
    const range = definitionRange(
      targetText,
      resolution.taskName,
      this.scanned(targetDocument, targetText)
    )
    if (!range) {
      warn(`No task or workflow "${resolution.taskName}" found in ${baseName(targetUri)}`)
      return
    }
    await this.revealRangeInDocument(targetDocument, range)
  }

  /**
   * Import paths are resolved against the importing document. `.with` keeps the
   * scheme and authority intact, so `vscode-remote://…` workspaces work; the
   * path join is done in pure code (`resolveImportPath`) rather than `Uri.joinPath`.
   */
  private resolveImportUri(baseUri: vscode.Uri, importPath: string): vscode.Uri | null {
    if (hasUriScheme(importPath)) return null
    return baseUri.with({ path: resolveImportPath(baseUri.path, importPath) })
  }

  private async revealRangeInDocument(
    document: vscode.TextDocument,
    range: OffsetRange
  ): Promise<void> {
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      // Focus stays in the graph so a run of clicks can be walked through.
      preserveFocus: true,
    })

    const start = document.positionAt(range.start)
    const end = document.positionAt(range.end)
    editor.selection = new vscode.Selection(start, end)
    editor.revealRange(
      new vscode.Range(start, end),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    )
  }
}
