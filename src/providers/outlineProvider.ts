// DocumentSymbol provider: Outline view, breadcrumbs and Ctrl+Shift+O.
//
// All the structural work happens in `outline.ts`; this file only converts
// offsets to `vscode.Range` and picks a `SymbolKind` icon for each block.
//
// This is the most frequently called provider in the extension — VS Code
// re-requests symbols on every cursor move to keep the breadcrumb path in sync —
// so it shares the `ScanCache` with the definition and folding providers rather
// than re-scanning the document each time.

import * as vscode from 'vscode'
import { outline } from '../language/outline'
import type { OutlineNode } from '../language/outline'
import type { BlockKind } from '../language/scanner'
import { ScanCache } from '../language/scanCache'

const SYMBOL_KINDS: Readonly<Record<BlockKind, vscode.SymbolKind>> = {
  workflow: vscode.SymbolKind.Namespace,
  task: vscode.SymbolKind.Function,
  struct: vscode.SymbolKind.Struct,
  call: vscode.SymbolKind.Method,
  if: vscode.SymbolKind.Object,
  scatter: vscode.SymbolKind.Object,
  input: vscode.SymbolKind.Struct,
  output: vscode.SymbolKind.Struct,
  command: vscode.SymbolKind.Method,
  runtime: vscode.SymbolKind.Object,
  meta: vscode.SymbolKind.Object,
  parameter_meta: vscode.SymbolKind.Object,
}

export class WdlOutlineProvider implements vscode.DocumentSymbolProvider {
  /** Optional with a working default so tests can construct this bare. */
  constructor(private readonly cache: ScanCache = new ScanCache()) {}

  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentSymbol[] {
    const text = document.getText()
    const blocks = this.cache.blocksFor(document.uri.toString(), document.version, text)
    // `text.length` is threaded through instead of re-reading the document per
    // node: on a large file there are hundreds of blocks, and each one used to
    // call `document.getText()` again just to clamp an offset.
    return toSymbols(document, outline(text, blocks), text.length)
  }
}

function toSymbols(
  document: vscode.TextDocument,
  nodes: OutlineNode[],
  textLength: number
): vscode.DocumentSymbol[] {
  return nodes.map((node) => {
    const symbol = new vscode.DocumentSymbol(
      node.name,
      node.detail,
      SYMBOL_KINDS[node.kind] ?? vscode.SymbolKind.Object,
      rangeOf(document, node.range.start, node.range.end, textLength),
      rangeOf(document, node.selectionRange.start, node.selectionRange.end, textLength)
    )
    symbol.children = toSymbols(document, node.children, textLength)
    return symbol
  })
}

/**
 * A block's `end` sits just past its closing brace, which lands on the line
 * *after* the brace when the file ends without a trailing newline. Clamping to
 * the last valid offset keeps `positionAt` from throwing on such documents.
 */
function rangeOf(
  document: vscode.TextDocument,
  start: number,
  end: number,
  textLength: number
): vscode.Range {
  const from = document.positionAt(Math.min(start, textLength))
  const to = document.positionAt(Math.min(end, textLength))
  return new vscode.Range(from, to)
}
