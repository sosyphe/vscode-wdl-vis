// Lexical parsing of top-level `import` statements.
//
// The scanner deliberately knows nothing about imports — they open no block —
// so go-to-definition recovers them here. A line-oriented regex is enough for
// the grammar (`import "path" [as alias]` may only sit at top level), and the
// scanned blocks are used to reject matches *inside* a block: `command` bodies
// routinely contain the word `import` (shell text, Python snippets), and every
// opaque or container block spans its full `[start, end)` range, so a simple
// containment test excludes them all.
//
// No `vscode` import here — this module is unit tested directly.

import type { ScannedBlock } from './scanner'

export interface WdlImport {
  /** Path exactly as written: `"lib/tasks.wdl"`, `'../x.wdl'`, or an http URL. */
  path: string
  /** Explicit `as ns` alias, or null when the import has none. */
  alias: string | null
  /** WDL's implicit namespace: file basename minus `.wdl` ('' when there is none). */
  defaultAlias: string
}

/**
 * `import "x.wdl" as ns` — both quote styles, optional alias, optional trailing
 * comment, and nothing else on the line (a `#` before `import` never matches,
 * so commented-out imports are ignored for free).
 *
 * Built per call rather than held at module scope: a `/g` regex carries mutable
 * `lastIndex`, so a shared instance is state that two callers could interleave.
 * Constructing it is nothing next to the scan of `text` that follows.
 */
function importLinePattern(): RegExp {
  return /^[ \t]*import[ \t]+(?:"([^"\n]*)"|'([^'\n]*)')[ \t]*(?:as[ \t]+([A-Za-z_]\w*))?[ \t]*(?:#[^\n]*)?$/gm
}

/** Strip a trailing `.wdl` from a file basename to get its default namespace. */
function stemOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  return base.replace(/\.wdl$/i, '')
}

/** Every real top-level import in `text`, in document order. */
export function parseImports(text: string, blocks: ScannedBlock[]): WdlImport[] {
  // Only top-level blocks need testing. Every block's `[start, end)` is
  // contained in its parent's — `scanRange` recurses over `bodyStart..end-1` at
  // `depth + 1`, and `end` is always the matching closer — so a point lying
  // inside *any* block lies inside that block's top-level ancestor as well.
  // Testing `depth === 0` alone is therefore equivalent to testing all of them,
  // and turns an O(imports × blocks) containment scan into
  // O(blocks + imports × top-level), where top-level is usually single digits.
  const topLevel = blocks.filter((b) => b.depth === 0)

  const pattern = importLinePattern()
  const out: WdlImport[] = []
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    // Reject anything inside a scanned block (command/meta bodies, nested WDL).
    if (topLevel.some((b) => b.start <= match.index && match.index < b.end)) continue
    const path = match[1] ?? match[2] ?? ''
    if (!path) continue
    out.push({ path, alias: match[3] ?? null, defaultAlias: stemOf(path) })
  }
  return out
}

/** True for `https://…`, `s3://…` etc. — anything with a `scheme://` prefix. */
export function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)
}

/** Directory part of a posix path: `/ws/a/b.wdl` → `/ws/a`, `/b.wdl` → `/`. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

/**
 * Resolve `rel` against directory `dir`, normalizing `.`/`..` and duplicate
 * slashes (a leading `/` in `rel` wins outright). Done in pure code rather than
 * `vscode.Uri.joinPath` so the result is deterministic and unit-testable.
 */
export function joinPosix(dir: string, rel: string): string {
  if (rel.startsWith('/')) return normalizePosix(rel)
  return normalizePosix(`${dir}/${rel}`)
}

/**
 * Resolve an `import` path against a base document path (both posix absolute
 * paths, e.g. `/ws/main.wdl` + `../shared/tasks.wdl` → `/ws/shared/tasks.wdl`).
 * Pure so the host can wrap it in `uri.with({ path })` and tests can call it
 * directly without a `vscode.Uri`.
 */
export function resolveImportPath(basePath: string, importPath: string): string {
  return joinPosix(dirName(basePath), importPath)
}

function normalizePosix(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Never climb past the root; an unmatched `..` is simply dropped.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!path.startsWith('/')) out.push('..')
      continue
    }
    out.push(segment)
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/')
}
