// Hand-written stand-in for the `vscode` module, aliased in vitest.config.ts.
//
// `vscode` is injected by the Extension Host at runtime and cannot be installed
// from npm, so anything that transitively imports it needs this stub to be
// unit-testable. Only the surface this extension actually touches is implemented.
//
// Everything mutable is funnelled through `__reset()` so tests cannot leak state
// into each other.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export class Position {
  constructor(readonly line: number, readonly character: number) {}

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character)
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }
}

export class Range {
  readonly start: Position
  readonly end: Position

  constructor(start: Position, end: Position)
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number)
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new Position(a, b)
      this.end = new Position(c ?? 0, d ?? 0)
    } else {
      this.start = a as Position
      this.end = b as Position
    }
    // Real vscode normalises so that start <= end; the extension never builds a
    // reversed range, so the mock keeps the arguments as given.
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }
}

export class Selection extends Range {
  readonly anchor: Position
  readonly active: Position

  constructor(anchor: Position, active: Position) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
  }
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}

export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath)
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/+$/, ''), ...segments].join('/')
    return new Uri(base.scheme, joined)
  }

  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path)
  }

  get fsPath(): string {
    return this.path
  }

  toString(): string {
    return `${this.scheme}://${this.path}`
  }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => {}) {}

  dispose(): void {
    this.callOnDispose()
  }

  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose()
    })
  }
}

/** Mirrors the numeric values of the real enum — providers only compare them. */
export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const

export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const

export class DocumentSymbol {
  children: DocumentSymbol[] = []

  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: number,
    readonly range: Range,
    readonly selectionRange: Range
  ) {}
}

export class FoldingRange {
  constructor(readonly start: number, readonly end: number, readonly kind?: unknown) {}
}

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

class Emitter<T> {
  private listeners: ((event: T) => void)[] = []

  readonly event = (listener: (event: T) => void): Disposable => {
    this.listeners.push(listener)
    return new Disposable(() => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    })
  }

  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /** Drop every listener — used by `__reset()` so subscriptions cannot leak
   *  between tests (each `activate()` adds one). */
  clear(): void {
    this.listeners = []
  }

  get listenerCount(): number {
    return this.listeners.length
  }
}

// ---------------------------------------------------------------------------
// Documents and editors
// ---------------------------------------------------------------------------

export interface FakeTextDocument {
  readonly uri: Uri
  readonly fileName: string
  languageId: string
  version: number
  isClosed: boolean
  readonly lineCount: number
  getText(): string
  positionAt(offset: number): Position
  offsetAt(position: Position): number
  lineAt(line: number): { text: string; range: Range }
}

export function createTextDocument(
  text: string,
  options: { uri?: string; languageId?: string } = {}
): FakeTextDocument {
  const uri = Uri.file(options.uri ?? '/workspace/test.wdl')
  const document: FakeTextDocument = {
    uri,
    fileName: uri.path,
    languageId: options.languageId ?? 'wdl',
    version: 1,
    isClosed: false,
    get lineCount() {
      return text.split('\n').length
    },
    getText: () => text,
    positionAt(offset: number) {
      const clamped = Math.max(0, Math.min(offset, text.length))
      const before = text.slice(0, clamped)
      const line = before.split('\n').length - 1
      const character = clamped - (before.lastIndexOf('\n') + 1)
      return new Position(line, character)
    },
    offsetAt(position: Position) {
      const lines = text.split('\n')
      let offset = 0
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1 // +1 for the '\n'
      }
      const lineLength = lines[position.line]?.length ?? 0
      return offset + Math.max(0, Math.min(position.character, lineLength))
    },
    lineAt(line: number) {
      const lines = text.split('\n')
      const content = lines[line] ?? ''
      return { text: content, range: new Range(new Position(line, 0), new Position(line, content.length)) }
    },
  }
  return document
}

export interface FakeTextEditor {
  readonly document: FakeTextDocument
  selection: Selection
  readonly revealed: { range: Range; type: number }[]
  revealRange(range: Range, type?: number): void
}

export function createTextEditor(document: FakeTextDocument): FakeTextEditor {
  return {
    document,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealed: [],
    revealRange(range: Range, type: number = TextEditorRevealType.Default) {
      this.revealed.push({ range, type })
    },
  }
}

// ---------------------------------------------------------------------------
// Webviews
// ---------------------------------------------------------------------------

export interface FakeWebview {
  html: string
  readonly cspSource: string
  /** Everything the host has posted, in order. */
  readonly posted: unknown[]
  asWebviewUri(localResource: Uri): Uri
  postMessage(message: unknown): Promise<boolean>
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable
  /** Test hook: pretend the webview script posted `message`. */
  receive(message: unknown): void
  readonly messageListenerCount: number
}

export interface FakeWebviewPanel {
  readonly viewType: string
  title: string
  viewColumn: number
  visible: boolean
  readonly webview: FakeWebview
  readonly options: unknown
  readonly disposed: boolean
  reveal(viewColumn?: number, preserveFocus?: boolean): void
  dispose(): void
  /** Test hook: flip visibility and fire `onDidChangeViewState`. */
  setVisible(visible: boolean): void
  readonly revealCount: number
  onDidChangeViewState(listener: (event: { webviewPanel: FakeWebviewPanel }) => void): Disposable
  onDidDispose(listener: () => void): Disposable
}

export function createWebviewPanelStub(
  viewType: string,
  title: string,
  showOptions: { viewColumn?: number } | number,
  options: unknown
): FakeWebviewPanel {
  const viewColumn =
    typeof showOptions === 'number' ? showOptions : (showOptions.viewColumn ?? ViewColumn.One)

  const received = new Emitter<unknown>()
  const viewState = new Emitter<{ webviewPanel: FakeWebviewPanel }>()
  const disposed = new Emitter<void>()
  const posted: unknown[] = []
  let revealCount = 0
  let isDisposed = false

  const webview: FakeWebview = {
    html: '',
    cspSource: 'https://file.vscode-cdn.net',
    posted,
    asWebviewUri: (localResource: Uri) =>
      Uri.file(`/vscode-resource${localResource.path}`),
    postMessage: (message: unknown) => {
      posted.push(message)
      return Promise.resolve(true)
    },
    onDidReceiveMessage: received.event,
    receive: (message: unknown) => received.fire(message),
    get messageListenerCount() {
      return received.listenerCount
    },
  }

  const panel: FakeWebviewPanel = {
    viewType,
    title,
    viewColumn,
    visible: true,
    webview,
    options,
    get disposed() {
      return isDisposed
    },
    reveal: (_column?: number, _preserveFocus?: boolean) => {
      revealCount++
    },
    dispose: () => disposed.fire(undefined),
    setVisible(visible: boolean) {
      panel.visible = visible
      viewState.fire({ webviewPanel: panel })
    },
    get revealCount() {
      return revealCount
    },
    onDidChangeViewState: viewState.event,
    onDidDispose: disposed.event,
  }

  disposed.event(() => {
    isDisposed = true
  })

  return panel
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

interface RegisteredProvider {
  selector: unknown
  provider: unknown
  metadata: unknown
}

export interface FakeOutputChannel {
  readonly name: string
  /** Every line appended, in order — asserted on by the diagnostics tests. */
  readonly lines: string[]
  appendLine(line: string): void
  show(preserveFocus?: boolean): void
  dispose(): void
  readonly showCount: number
  readonly disposed: boolean
}

function createOutputChannelStub(name: string): FakeOutputChannel {
  const lines: string[] = []
  let showCount = 0
  let disposed = false
  return {
    name,
    lines,
    appendLine: (line: string) => lines.push(line),
    show: (_preserveFocus?: boolean) => {
      showCount++
    },
    dispose: () => {
      disposed = true
    },
    get showCount() {
      return showCount
    },
    get disposed() {
      return disposed
    },
  }
}

export const window = {
  activeTextEditor: undefined as FakeTextEditor | undefined,
  visibleTextEditors: [] as FakeTextEditor[],
  panels: [] as FakeWebviewPanel[],
  shownEditors: [] as { document: FakeTextDocument; options: unknown; editor: FakeTextEditor }[],
  informationMessages: [] as string[],
  warningMessages: [] as string[],
  outputChannels: [] as FakeOutputChannel[],

  createOutputChannel(name: string): FakeOutputChannel {
    const channel = createOutputChannelStub(name)
    window.outputChannels.push(channel)
    return channel
  },

  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: { viewColumn?: number } | number,
    options: unknown
  ): FakeWebviewPanel {
    const panel = createWebviewPanelStub(viewType, title, showOptions, options)
    window.panels.push(panel)
    return panel
  },

  showTextDocument(document: FakeTextDocument, options?: unknown): Promise<FakeTextEditor> {
    const editor = createTextEditor(document)
    window.shownEditors.push({ document, options, editor })
    return Promise.resolve(editor)
  },

  showInformationMessage(message: string): Promise<undefined> {
    window.informationMessages.push(message)
    return Promise.resolve(undefined)
  },

  showWarningMessage(message: string): Promise<undefined> {
    window.warningMessages.push(message)
    return Promise.resolve(undefined)
  },
}

/** Held separately so `fireDocumentChange` can drive `onDidChangeTextDocument`. */
const documentChanges = new Emitter<{ document: FakeTextDocument }>()

/**
 * Real VS Code hands the document itself to this listener, not a wrapper object.
 * Held separately so `fireDocumentClose` can drive it.
 */
const documentCloses = new Emitter<FakeTextDocument>()

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Flat `"section.key" → value` store backing `getConfiguration`. */
const configValues = new Map<string, unknown>()

const configurationChanges = new Emitter<{ affectsConfiguration(section: string): boolean }>()

/** Mirrors the numeric values of the real enum. */
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const

export const workspace = {
  textDocuments: [] as FakeTextDocument[],

  /** Every `update()` call, in order — asserted on by tests. */
  configUpdates: [] as { key: string; value: unknown; target: number | undefined }[],

  onDidChangeTextDocument: documentChanges.event,

  onDidCloseTextDocument: documentCloses.event,

  onDidChangeConfiguration: configurationChanges.event,

  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue: T): T {
        const full = section ? `${section}.${key}` : key
        return configValues.has(full) ? (configValues.get(full) as T) : defaultValue
      },

      /** Records, applies, and fires the change event — as real VS Code does. */
      update(key: string, value: unknown, target?: number): Promise<void> {
        const full = section ? `${section}.${key}` : key
        workspace.configUpdates.push({ key: full, value, target })
        configValues.set(full, value)
        configurationChanges.fire({
          affectsConfiguration: (queried: string) =>
            full === queried ||
            full.startsWith(`${queried}.`) ||
            queried.startsWith(`${full}.`),
        })
        return Promise.resolve()
      },
    }
  },

  openTextDocument(uri: Uri | string): Promise<FakeTextDocument> {
    const target = typeof uri === 'string' ? Uri.file(uri) : uri
    const found = workspace.textDocuments.find((doc) => doc.uri.toString() === target.toString())
    if (!found) return Promise.reject(new Error(`not open: ${target.toString()}`))
    return Promise.resolve(found)
  },
}

export const languages = {
  registered: [] as RegisteredProvider[],

  registerDocumentSymbolProvider(selector: unknown, provider: unknown, metadata?: unknown) {
    languages.registered.push({ selector, provider, metadata })
    return new Disposable()
  },

  registerFoldingRangeProvider(selector: unknown, provider: unknown) {
    languages.registered.push({ selector, provider, metadata: undefined })
    return new Disposable()
  },

  registerDefinitionProvider(selector: unknown, provider: unknown) {
    languages.registered.push({ selector, provider, metadata: undefined })
    return new Disposable()
  },
}

export const commands = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),

  registerCommand(id: string, callback: (...args: unknown[]) => unknown) {
    commands.handlers.set(id, callback)
    return new Disposable(() => commands.handlers.delete(id))
  },

  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = commands.handlers.get(id)
    if (!handler) return Promise.reject(new Error(`command not found: ${id}`))
    return Promise.resolve(handler(...args))
  },
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Fire `workspace.onDidChangeTextDocument`, as VS Code does on every keystroke. */
export function fireDocumentChange(document: FakeTextDocument): void {
  documentChanges.fire({ document })
}

/** Fire `workspace.onDidCloseTextDocument`, as VS Code does when a tab closes. */
export function fireDocumentClose(document: FakeTextDocument): void {
  documentCloses.fire(document)
}

/** Set a `"section.key"` configuration value (does not fire a change event). */
export function setConfiguration(key: string, value: unknown): void {
  configValues.set(key, value)
}

/** Fire `workspace.onDidChangeConfiguration` for the given setting section. */
export function fireConfigurationChange(section: string): void {
  configurationChanges.fire({
    affectsConfiguration: (queried: string) =>
      section === queried || section.startsWith(`${queried}.`) || queried.startsWith(`${section}.`),
  })
}

export function __reset(): void {
  documentChanges.clear()
  documentCloses.clear()
  configurationChanges.clear()
  configValues.clear()
  workspace.configUpdates = []
  window.activeTextEditor = undefined
  window.visibleTextEditors = []
  window.panels = []
  window.shownEditors = []
  window.informationMessages = []
  window.warningMessages = []
  window.outputChannels = []
  workspace.textDocuments = []
  languages.registered = []
  commands.handlers.clear()
}
