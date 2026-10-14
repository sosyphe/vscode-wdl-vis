// Folding ranges, derived from the same structural scan that powers Outline.
//
// Offsets are returned rather than line numbers so this module never needs a
// `vscode.TextDocument`; `foldProvider.ts` converts with `document.positionAt`.

import { scanDocument } from './scanner'
import type { BlockKind, ScannedBlock } from './scanner'

export interface FoldRange {
  /** Offset of the block's opening keyword. */
  start: number
  /** Offset just past the closing `}` / `>>>`. */
  end: number
  kind: BlockKind
}

/**
 * Every block that has a body can fold: workflow / task / struct, `call { … }`,
 * `if` / `scatter`, `input` / `output`, and `command` in both the brace and the
 * `<<< … >>>` heredoc form.
 *
 * Braceless blocks (a bare `call foo`) are skipped — there is nothing to hide.
 * Single-line blocks are *not* filtered here because that needs line positions;
 * the provider drops them.
 *
 * `blocks` defaults to a fresh scan; `foldProvider.ts` passes in the shared
 * `ScanCache` result, so a fold refresh no longer re-scans the document that the
 * symbol and definition providers just scanned.
 */
export function folds(text: string, blocks: ScannedBlock[] = scanDocument(text)): FoldRange[] {
  const out: FoldRange[] = []
  for (const block of blocks) {
    if (!block.hasBody) continue
    out.push({ start: block.start, end: block.end, kind: block.kind })
  }
  return out
}
