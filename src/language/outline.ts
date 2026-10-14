// Turns the flat scanner output into the nested tree that Outline, breadcrumbs
// and "Go to Symbol" all consume.
//
// No `vscode` import here — `outlineProvider.ts` does the mapping to
// `vscode.DocumentSymbol` so this module stays unit-testable.

import { blockDisplayName, scanDocument } from './scanner'
import type { BlockKind, ScannedBlock } from './scanner'


export interface OffsetRange {
  start: number
  end: number
}

export interface OutlineNode {
  kind: BlockKind
  /** Primary text: `workflow Foo`, `call bar`, `if (x > 2)`, `input`, … */
  name: string
  /** Secondary text, shown greyed after `name`. Empty when there is nothing to add. */
  detail: string
  /** The whole block, including braces. */
  range: OffsetRange
  /** The identifying part — what a click should select. */
  selectionRange: OffsetRange
  children: OutlineNode[]
}

/** Length of the opening keyword, used to select unnamed blocks like `input`. */
function keywordEnd(block: ScannedBlock): number {
  return block.start + block.kind.length
}

/**
 * Walk back over spaces and tabs so a selection never ends in trailing
 * whitespace — `if (x) {` should highlight as `if (x)`, not `if (x) `.
 * Exported for `reveal.ts`, which highlights the same headers.
 */
export function trimTrailingWhitespace(text: string, end: number, floor: number): number {
  let i = end
  while (i > floor && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--
  return i
}

/**
 * What a click in Outline should highlight: the declared name when there is one,
 * the `if (…)` / `scatter (…)` header for control blocks, and just the keyword
 * for anonymous sections.
 */
function selectionOf(text: string, block: ScannedBlock): OffsetRange {
  if (block.nameStart !== -1) {
    return { start: block.nameStart, end: block.nameEnd }
  }
  if (block.kind === 'if' || block.kind === 'scatter') {
    // Up to (not including) the opening brace, so the condition stays visible.
    const raw = block.braceStart === -1 ? block.end : block.braceStart
    return { start: block.start, end: trimTrailingWhitespace(text, raw, block.start) }
  }
  return { start: block.start, end: keywordEnd(block) }
}

function detailOf(block: ScannedBlock): string {
  // `call analyze as step1` — the alias is the name, so surface the real task.
  if (block.kind === 'call' && block.alias !== null && block.name !== null) {
    return block.name
  }
  return ''
}

/**
 * Build the document outline. Nodes come back in document order at every level,
 * so the tree can be rendered directly.
 *
 * `blocks` defaults to a fresh scan; `outlineProvider.ts` passes in the shared
 * `ScanCache` result instead. That matters more here than anywhere else — VS
 * Code re-requests symbols on every cursor move to keep breadcrumbs in sync.
 *
 * Malformed input yields a truncated tree rather than throwing.
 */
export function outline(
  text: string,
  blocks: ScannedBlock[] = scanDocument(text)
): OutlineNode[] {
  const nodes: OutlineNode[] = blocks.map((block) => ({
    kind: block.kind,
    name: blockDisplayName(block),
    detail: detailOf(block),
    range: { start: block.start, end: block.end },
    selectionRange: selectionOf(text, block),
    children: [],
  }))

  const roots: OutlineNode[] = []
  blocks.forEach((block, index) => {
    const node = nodes[index]
    if (block.parent === -1) {
      roots.push(node)
    } else {
      nodes[block.parent].children.push(node)
    }
  })

  return roots
}

/** Depth-first flatten, handy for tests and for "Go to Symbol" lists. */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}
