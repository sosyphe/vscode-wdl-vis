// Resolves a `call` to the definition of the task (or sub-workflow) it invokes
// — the go-to-definition half of the reveal pipeline. Two consumers:
//
//   1. the graph webview's Ctrl/Cmd+click path, which starts from a clicked
//      node id (`resolveCallDefinition`);
//   2. the editor's DefinitionProvider, which starts from a cursor offset
//      (`findCallAtOffset`).
//
// The graph only carries the *short* task name: the library's parser strips the
// module prefix from `call lib.align` before it ever reaches the webview. The
// fully qualified target is therefore recovered from the source text via the
// scanner (`findCallBlock`), which keeps `name` exactly as written. Namespaces
// are then mapped through the file's `import` statements (`resolveQualified`);
// turning an import path into a URI is left to the callers (that part needs
// `vscode`).
//
// No `vscode` import here — this module is unit tested directly.

import { scanDocument, skipTrivia, readQualifiedName } from './scanner'
import type { ScannedBlock } from './scanner'
import { findCallBlock, headerRange } from './reveal'
import { parseImports, hasUriScheme } from './imports'
import type { WdlImport } from './imports'
import type { SelectedNode } from '../graph/protocol'
import type { OffsetRange } from './outline'

export type CallDefinition =
  /** The target is a task/workflow defined in the same document. */
  | { type: 'same-file'; taskName: string }
  /** The target lives in an imported file, relative to the current document. */
  | { type: 'imported'; importPath: string; namespace: string; taskName: string }
  /** The target could not be resolved; `reason` drives the user-facing warning. */
  | {
      type: 'unresolved'
      reason: 'no-target' | 'unknown-namespace' | 'remote-import'
      detail: string
      taskName: string | null
    }

/**
 * Work out where the definition of the task a `call` node refers to lives.
 * `text` is the document the graph was drawn from.
 *
 * `blocks` is optional so a caller that has already scanned the document — the
 * graph panel, which resolves through the shared `ScanCache` — can hand the
 * result in instead of paying for a second scan.
 */
export function resolveCallDefinition(
  text: string,
  node: SelectedNode,
  blocks: ScannedBlock[] = scanDocument(text)
): CallDefinition {
  const call = findCallBlock(blocks, node)

  // The scanned call block recovers the qualified name as written
  // (`lib.align`); a stale node id falls back to the short name from the graph.
  const qualified = call?.name ?? node.taskName
  if (!qualified) return { type: 'unresolved', reason: 'no-target', detail: '', taskName: null }

  return resolveQualified(text, blocks, qualified)
}

/**
 * Namespace/import resolution for a qualified call target exactly as written
 * (`qc`, `lib.align`), given the document's pre-scanned blocks. Shared by the
 * webview click path and the editor DefinitionProvider.
 */
export function resolveQualified(
  text: string,
  blocks: ScannedBlock[],
  qualified: string,
  importsOf?: () => WdlImport[]
): CallDefinition {
  const dot = qualified.lastIndexOf('.')
  if (dot === -1) return { type: 'same-file', taskName: qualified }

  const namespace = qualified.slice(0, dot)
  const taskName = qualified.slice(dot + 1)
  // A thunk rather than a plain array: the undotted case above never needs
  // imports at all, and callers holding a `ScanCache` want to skip the regex
  // pass on a cache hit. Defaulting here keeps this module free of the cache.
  const imports = (importsOf ?? (() => parseImports(text, blocks)))()
  // An explicit `as ns` wins over another import's implicit (file-stem) alias,
  // regardless of document order. Valid WDL forbids duplicate namespaces, so
  // this only matters for degraded input.
  const wdlImport =
    imports.find((i) => i.alias === namespace) ??
    imports.find((i) => i.alias === null && i.defaultAlias === namespace)

  if (!wdlImport) {
    return { type: 'unresolved', reason: 'unknown-namespace', detail: namespace, taskName }
  }
  if (hasUriScheme(wdlImport.path)) {
    return { type: 'unresolved', reason: 'remote-import', detail: wdlImport.path, taskName }
  }
  return { type: 'imported', importPath: wdlImport.path, namespace, taskName }
}

/**
 * The `call` block whose qualified target name — or alias — `offset` sits on,
 * or null when the cursor is anywhere else.
 *
 * The target span is re-derived with the scanner's own readers because an
 * aliased call (`call lib.align as aligned`) stores the *alias* span in
 * `nameStart/nameEnd`, not the task-name span. Both spans count as hits:
 * Ctrl+clicking either name of a call should reach the definition. Bounds are
 * end-inclusive (`start <= offset <= end`), matching VS Code's word-range
 * semantics — a cursor just past the last character still belongs to the word.
 */
export function findCallAtOffset(
  text: string,
  blocks: ScannedBlock[],
  offset: number
): ScannedBlock | null {
  for (const b of blocks) {
    // Blocks arrive pre-order, so `start` is ascending. Both spans this
    // function tests begin at or after `b.start` — the target name via
    // `skipTrivia(b.start + 4)`, the alias via `nameStart >= b.start` — and the
    // end-inclusive bounds only ever extend rightwards. Once a block starts
    // past the offset, no later block can contain it either.
    //
    // (A binary search would save more still, but is not provably safe: the
    // trivia between `call` and its name is unbounded, so there is no backward
    // window a match could hide in. The linear walk with this break is exact.)
    if (b.start > offset) break

    if (b.kind !== 'call' || b.name === null) continue

    // Same derivation as readBlock: skip trivia past the `call` keyword, then
    // read the dotted name.
    const namePos = skipTrivia(text, b.start + 'call'.length)
    const target = readQualifiedName(text, namePos)
    // Defensive: a re-read that disagrees with the scan (should be impossible —
    // same readers, same input) is skipped rather than trusted with a wrong span.
    if (target.value !== b.name) continue

    if (namePos <= offset && offset <= target.end) return b
    if (b.alias !== null && b.nameStart <= offset && offset <= b.nameEnd) return b
  }
  return null
}

/**
 * Header range of the first `task`/`workflow` named `name` in `text`, or null.
 * Workflows count too — a `call` may target an imported sub-workflow.
 *
 * `blocks` defaults to a fresh scan, which keeps the two-argument call sites
 * working; callers that already scanned `text` — every real one, since the
 * resolution step needed the same blocks — pass them in and skip the rescan.
 * That rescan was half the cost of a same-file jump.
 */
export function definitionRange(
  text: string,
  name: string,
  blocks: ScannedBlock[] = scanDocument(text)
): OffsetRange | null {
  const block = blocks.find(
    (b) => (b.kind === 'task' || b.kind === 'workflow') && b.name === name
  )
  return block ? headerRange(text, block) : null
}
