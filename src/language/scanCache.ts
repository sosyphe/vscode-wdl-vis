// A shared, per-document memo of `scanDocument` (and of `parseImports`).
//
// Why this exists: the scan is pure and O(n), but nothing used to be shared.
// One Ctrl+click scanned the same unchanged 113 KB document *twice*
// (`provideDefinition`, then again inside `definitionRange`), and the Outline
// and Folding providers each re-scanned it independently — the symbol provider
// runs on every cursor move because breadcrumbs track the caret. VS Code also
// calls a definition provider several times per gesture (link detection while
// Ctrl is held, then the click), so the redundancy multiplied.
//
// Keyed by document URI, validated by `version` *and* by text identity.
//
// Why text identity and not version alone: `version` is authoritative in real
// VS Code, but it is not the whole story — a document closed and reopened can
// come back at a version that collides with a stale entry, and the test mocks
// pin `version` to 1 while feeding one URI many different texts. Comparing the
// text closes both holes, and `scanDocument` being pure makes text equality a
// *sufficient* validity condition, not a heuristic. The comparison is cheap:
// an unchanged document hands back the same string object, so `===` is a
// pointer check, and even a full 113 KB memcmp is microseconds against the
// milliseconds a rescan costs.
//
// Bounded LRU rather than a WeakMap: the entries are keyed by URI string, so a
// document that is closed and never invalidated still gets evicted, and the
// cache stays inspectable from tests. A WeakMap keyed on `TextDocument` would
// leak whenever VS Code hands out a fresh object for the same file.
//
// No `vscode` import here — this module is unit tested directly.

import { scanDocument } from './scanner'
import type { ScannedBlock } from './scanner'
import { parseImports } from './imports'
import type { WdlImport } from './imports'

/** How many documents to keep warm. Editing rarely spans more than a couple. */
const MAX_DOCUMENTS = 8

interface Entry {
  version: number
  text: string
  blocks: ScannedBlock[]
  /** Computed on first request — most documents never resolve a dotted call. */
  imports: WdlImport[] | null
}

export interface ScanCacheStats {
  hits: number
  misses: number
  /** Documents currently held. */
  size: number
}

export class ScanCache {
  /** Insertion-ordered; re-inserting on hit moves an entry to the MRU end. */
  private readonly entries = new Map<string, Entry>()
  private hitCount = 0
  private missCount = 0

  constructor(private readonly maxDocuments: number = MAX_DOCUMENTS) {}

  /** The block tree for `text`, reused when nothing relevant has changed. */
  blocksFor(uri: string, version: number, text: string): ScannedBlock[] {
    return this.entryFor(uri, version, text).blocks
  }

  /**
   * Top-level imports for `text`, memoized alongside the blocks.
   * `blocks` must be the array this cache returned for the same text.
   */
  importsFor(
    uri: string,
    version: number,
    text: string,
    blocks: ScannedBlock[]
  ): WdlImport[] {
    const entry = this.entryFor(uri, version, text)
    if (entry.imports === null) entry.imports = parseImports(text, blocks)
    return entry.imports
  }

  private entryFor(uri: string, version: number, text: string): Entry {
    const existing = this.entries.get(uri)

    // Version is the cheap pre-filter: a different version has definitely
    // changed, so skip the string comparison entirely.
    if (existing !== undefined && existing.version === version && existing.text === text) {
      this.hitCount++
      // Refresh recency: re-insert so eviction takes the least-recently-used.
      this.entries.delete(uri)
      this.entries.set(uri, existing)
      return existing
    }

    this.missCount++
    const entry: Entry = { version, text, blocks: scanDocument(text), imports: null }
    this.entries.delete(uri)
    this.entries.set(uri, entry)
    this.evict()
    return entry
  }

  private evict(): void {
    while (this.entries.size > this.maxDocuments) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.entries.delete(oldest.value)
    }
  }

  /** Drop one document — wired to `onDidCloseTextDocument`. */
  invalidate(uri: string): void {
    this.entries.delete(uri)
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get stats(): ScanCacheStats {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size }
  }
}
