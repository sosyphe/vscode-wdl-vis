// Message contract between the extension host and the graph webview.
//
// This module is imported by *both* bundles (dist/extension.js and
// dist/webview.js), so it must stay free of `vscode` imports. The `wdl-viewer`
// import below is type-only and is erased by esbuild.

import type { NodeKind, WdlNode } from 'wdl-viewer/parser'

/**
 * The subset of a `WdlNode` that crosses the webview boundary. Coordinates and
 * port lists stay behind — the host only needs enough to locate the source block.
 */
export interface SelectedNode {
  id: string
  kind: NodeKind
  label: string
  taskName: string | null
}

/**
 * Graph background mode, mirroring the `wdl.viewer.background` setting.
 * The webview applies it as `document.body.dataset.wdlBg`, which theme.css
 * keys its two complete palettes off: `light`/`dark` pin one palette, while
 * `auto` selects between them from the workbench theme's body class
 * (`vscode-dark`/`vscode-high-contrast` → dark, otherwise light).
 */
export const BACKGROUNDS = ['auto', 'light', 'dark'] as const
export type Background = (typeof BACKGROUNDS)[number]

/** Extension host → webview. */
export type HostMessage =
  | { type: 'init'; text: string; fileName: string; background: Background }
  | { type: 'update'; text: string; fileName: string; background: Background }

/** Webview → extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  /**
   * A graph node was clicked. `goToDefinition` is true when the click carried
   * Ctrl/Cmd — the host then reveals the *task definition* a call refers to
   * (following `import`s across files) instead of the call statement itself.
   * Optional so older payloads and deselections stay valid.
   */
  | { type: 'nodeSelect'; node: SelectedNode | null; goToDefinition?: boolean }
  | { type: 'parseError'; errors: string[] }
  | { type: 'backgroundSelect'; background: Background }

/** All node kinds WdlViewer can emit, used to validate inbound messages. */
export const NODE_KINDS: readonly NodeKind[] = [
  'workflow_input',
  'workflow_output',
  'call',
  'if_group',
  'scatter_group',
]

/** Slim a full `WdlNode` down to what the host actually consumes. */
export function pickNode(node: WdlNode): SelectedNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    taskName: node.taskName,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Runtime guard for messages arriving from the webview (untrusted `unknown`). */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!isRecord(value)) return false

  switch (value.type) {
    case 'ready':
      return true

    case 'parseError':
      return isStringArray(value.errors)

    case 'backgroundSelect':
      return BACKGROUNDS.includes(value.background as Background)

    case 'nodeSelect': {
      if (value.goToDefinition !== undefined && typeof value.goToDefinition !== 'boolean') {
        return false
      }
      if (value.node === null) return true
      if (!isRecord(value.node)) return false
      const node = value.node
      return (
        typeof node.id === 'string' &&
        typeof node.label === 'string' &&
        (node.taskName === null || typeof node.taskName === 'string') &&
        NODE_KINDS.includes(node.kind as NodeKind)
      )
    }

    default:
      return false
  }
}

/** Runtime guard for messages arriving from the extension host. */
export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value)) return false
  if (value.type !== 'init' && value.type !== 'update') return false
  if (typeof value.text !== 'string' || typeof value.fileName !== 'string') return false
  return BACKGROUNDS.includes(value.background as Background)
}
