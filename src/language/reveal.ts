// Maps a node clicked in the graph webview back to a source range.
//
// The webview only sends `{ id, kind, label, taskName }` (see protocol.ts), so
// everything here is inferred from the document text. Ids come from
// `wdl-viewer`'s graph builder:
//
//   __wf_inputs / __wf_outputs   the workflow's input / output block
//   <effectiveName>              a `call` — alias when present, else task name
//   __if_<n> / __scatter_<n>     <n> is a pre-order counter over *all* if and
//                                scatter blocks inside the first workflow
//
// The counter is the only way to tell two `if` blocks apart (their labels are
// both the literal `if (...)`), so the same pre-order walk is replayed here over
// the scanner's blocks. When the walk disagrees with the parser — malformed
// source, a partially-parsed document — the kind check fails and we fall back to
// the enclosing workflow rather than jumping somewhere wrong.

import { scanDocument } from './scanner'
import type { ScannedBlock } from './scanner'
import type { SelectedNode } from '../graph/protocol'
import { trimTrailingWhitespace } from './outline'
import type { OffsetRange } from './outline'

/**
 * The part of a block worth selecting: from the opening keyword through its name,
 * or through the whole header for anonymous and control blocks (`input`,
 * `if (x > 2)`). Never the full block — a 40-line `call` should still centre the
 * editor on its first line.
 */
export function headerRange(text: string, block: ScannedBlock): OffsetRange {
  if (block.nameStart !== -1) {
    return { start: block.start, end: block.nameEnd }
  }
  const raw = block.braceStart === -1 ? block.end : block.braceStart
  return { start: block.start, end: trimTrailingWhitespace(text, raw, block.start) }
}

/** Index range of `blocks[parentIndex]`'s descendants (pre-order, contiguous). */
function descendantRange(blocks: ScannedBlock[], parentIndex: number): { from: number; to: number } {
  const depth = blocks[parentIndex].depth
  let i = parentIndex + 1
  while (i < blocks.length && blocks[i].depth > depth) i++
  return { from: parentIndex + 1, to: i }
}

function firstChildOfKind(blocks: ScannedBlock[], parentIndex: number, kind: string): ScannedBlock | null {
  const { from, to } = descendantRange(blocks, parentIndex)
  for (let i = from; i < to; i++) {
    if (blocks[i].kind === kind && blocks[i].depth === blocks[parentIndex].depth + 1) return blocks[i]
  }
  return null
}

/** `call lib.task as t` and `call task` both have to match `taskName === 'task'`. */
function callMatchesTask(block: ScannedBlock, taskName: string): boolean {
  if (block.name === null) return false
  if (block.name === taskName) return true
  return block.name.endsWith('.' + taskName)
}

/**
 * The scanned `call` block a clicked graph node refers to, or null.
 *
 * Matching is two-pass, mirroring the graph builder: the node id is the call's
 * effective name (alias when present), so an exact `(alias ?? name) === id`
 * match wins; only when that fails — the source was edited after the graph was
 * drawn — fall back to any call of the same task. Scoped to the first
 * workflow's descendants because that is the only scope the graph renders.
 *
 * Shared by `revealRange` (reveal the call statement) and `definition.ts`
 * (recover the fully qualified call target for go-to-definition).
 */
export function findCallBlock(blocks: ScannedBlock[], node: SelectedNode): ScannedBlock | null {
  const workflowIndex = blocks.findIndex((b) => b.kind === 'workflow')
  if (workflowIndex === -1) return null
  const { from, to } = descendantRange(blocks, workflowIndex)

  for (let i = from; i < to; i++) {
    const b = blocks[i]
    if (b.kind !== 'call') continue
    if ((b.alias ?? b.name) === node.id) return b
  }
  if (node.taskName !== null) {
    for (let i = from; i < to; i++) {
      const b = blocks[i]
      if (b.kind === 'call' && callMatchesTask(b, node.taskName)) return b
    }
  }
  return null
}

/**
 * Resolve a clicked graph node to a source range, or null when the document has
 * no workflow to point at.
 *
 * `blocks` defaults to a fresh scan; `graphPanel.ts` passes the shared
 * `ScanCache` result so a click does not re-scan a document that is unchanged.
 */
export function revealRange(
  text: string,
  node: SelectedNode,
  blocks: ScannedBlock[] = scanDocument(text)
): OffsetRange | null {
  // The graph only ever renders the first workflow, so that is the only scope
  // these ids can refer to.
  const workflowIndex = blocks.findIndex((b) => b.kind === 'workflow')
  if (workflowIndex === -1) return null
  const workflow = blocks[workflowIndex]
  const { from, to } = descendantRange(blocks, workflowIndex)

  switch (node.kind) {
    case 'workflow_input':
    case 'workflow_output': {
      const kind = node.kind === 'workflow_input' ? 'input' : 'output'
      const block = firstChildOfKind(blocks, workflowIndex, kind)
      return headerRange(text, block ?? workflow)
    }

    case 'call': {
      // Prefer the `call` statement itself.
      const call = findCallBlock(blocks, node)
      if (call) return headerRange(text, call)
      // No call block (e.g. the source was edited after the graph was drawn):
      // the task may still be defined further down the file.
      if (node.taskName !== null) {
        const task = blocks.find((b) => b.kind === 'task' && b.name === node.taskName)
        if (task) return headerRange(text, task)
      }
      return headerRange(text, workflow)
    }

    case 'if_group':
    case 'scatter_group': {
      const group = resolveGroup(blocks, from, to, node)
      return headerRange(text, group ?? workflow)
    }

    default:
      return headerRange(text, workflow)
  }
}

/**
 * Replay the graph builder's pre-order counter. `__if_2` means "the third if or
 * scatter encountered while walking the workflow body depth-first".
 */
function resolveGroup(
  blocks: ScannedBlock[],
  from: number,
  to: number,
  node: SelectedNode
): ScannedBlock | null {
  const expectedKind = node.kind === 'if_group' ? 'if' : 'scatter'
  const match = /^__(?:if|scatter)_(\d+)$/.exec(node.id)

  if (match) {
    const ordinal = Number(match[1])
    let counter = 0
    for (let i = from; i < to; i++) {
      const b = blocks[i]
      if (b.kind !== 'if' && b.kind !== 'scatter') continue
      if (counter === ordinal) return b.kind === expectedKind ? b : null
      counter++
    }
    return null
  }

  // Unrecognised id shape — for a scatter the label still carries the loop
  // variable, which is usually enough to find the right block.
  if (expectedKind === 'scatter') {
    const variable = /^scatter\s*\(\s*([A-Za-z_]\w*)/.exec(node.label)?.[1]
    if (variable) {
      for (let i = from; i < to; i++) {
        const b = blocks[i]
        if (b.kind === 'scatter' && b.header?.trimStart().startsWith(variable)) return b
      }
    }
  }
  return null
}
