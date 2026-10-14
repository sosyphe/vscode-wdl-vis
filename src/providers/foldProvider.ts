// FoldingRange provider: the gutter arrows next to every WDL block.
//
// `fold.ts` yields offsets; VS Code wants line numbers, and only ranges spanning
// at least two lines are worth offering.
//
// Shares the `ScanCache` with the symbol and definition providers: a fold
// refresh used to mean another full scan of a document the other two had just
// scanned.

import * as vscode from 'vscode'
import { folds } from '../language/fold'
import { ScanCache } from '../language/scanCache'

export class WdlFoldProvider implements vscode.FoldingRangeProvider {
  /** Optional with a working default so tests can construct this bare. */
  constructor(private readonly cache: ScanCache = new ScanCache()) {}

  provideFoldingRanges(
    document: vscode.TextDocument,
    _context: vscode.FoldingContext,
    _token: vscode.CancellationToken
  ): vscode.FoldingRange[] {
    const text = document.getText()
    const blocks = this.cache.blocksFor(document.uri.toString(), document.version, text)
    const out: vscode.FoldingRange[] = []

    for (const fold of folds(text, blocks)) {
      const startLine = document.positionAt(Math.min(fold.start, text.length)).line
      const endLine = document.positionAt(Math.min(fold.end, text.length)).line
      if (endLine <= startLine) continue // single-line block — nothing to hide
      out.push(new vscode.FoldingRange(startLine, endLine))
    }

    return out
  }
}
