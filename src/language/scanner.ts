// Single-pass structural scan of a WDL document.
//
// Why this exists instead of reusing `wdl-viewer/parser`'s `findTaskBlock` and
// friends: those helpers locate the *first* block matching a name, which is the
// right semantics for "reveal this node" but cannot produce a document tree —
// the same task is routinely called twice, and Outline/Folding need *every*
// occurrence with exact nesting. This scanner walks the text once and emits the
// whole block tree in document order.
//
// It is deliberately lexical, not syntactic: it skips comments and strings so
// braces inside them cannot throw off matching, and it treats `command` bodies
// as opaque (never recursing into shell text, where a stray apostrophe or `{`
// would otherwise derail the scan).
//
// No `vscode` import here — this module is unit tested directly.

export type BlockKind =
  | 'workflow'
  | 'task'
  | 'struct'
  | 'call'
  | 'if'
  | 'scatter'
  | 'input'
  | 'output'
  | 'command'
  | 'runtime'
  | 'meta'
  | 'parameter_meta'

export interface ScannedBlock {
  kind: BlockKind
  /** Declared name: workflow/task/struct name, or the task being called. */
  name: string | null
  /** `call X as Y` alias, when present. */
  alias: string | null
  /** Parenthesised header of `if (...)` / `scatter (...)`, without the parens. */
  header: string | null
  /** Offset of the keyword that opens the block. */
  start: number
  /** Offset just past the block's closing brace, `>>>`, or end of line. */
  end: number
  /** Offsets of `name` within the document, or -1 when the block is unnamed. */
  nameStart: number
  nameEnd: number
  /** Offset just past the opening brace, or -1 for braceless blocks. */
  bodyStart: number
  /** Offset of the opening brace, or -1 for braceless blocks. */
  braceStart: number
  /** Nesting depth; 0 means top level. */
  depth: number
  /** Index of the enclosing block in the returned array, or -1 at top level. */
  parent: number
  /** Whether the block has a `{ … }` body at all (a bare `call X` does not). */
  hasBody: boolean
}

/** Kinds whose bodies are WDL and worth descending into. */
const CONTAINER_KEYWORDS: ReadonlySet<string> = new Set([
  'workflow',
  'task',
  'struct',
  'call',
  'if',
  'scatter',
  'input',
  'output',
])

/** Kinds whose bodies are not WDL (shell script, free-form metadata). */
const OPAQUE_KEYWORDS: ReadonlySet<string> = new Set([
  'command',
  'runtime',
  'meta',
  'parameter_meta',
])

function isWordStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isWordChar(ch: string): boolean {
  return isWordStart(ch) || (ch >= '0' && ch <= '9')
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

function endOfLine(text: string, from: number): number {
  const nl = text.indexOf('\n', from)
  return nl === -1 ? text.length : nl
}

/** Skip a `# …` comment; returns the index of the newline (or EOF). */
function skipLineComment(text: string, from: number): number {
  const nl = text.indexOf('\n', from)
  return nl === -1 ? text.length : nl
}

/** Skip a double-quoted WDL string starting at the opening quote. */
function skipString(text: string, from: number): number {
  let i = from + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') return i + 1
    i++
  }
  return text.length // unterminated — swallow the rest rather than desync
}

/**
 * Given the offset of an opening bracket, return the offset just past its
 * matching closer. Comments and strings are skipped so brackets inside them do
 * not count. Returns -1 when the brackets never balance.
 */
function matchBracket(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (ch === '#') {
      i = skipLineComment(text, i)
      continue
    }
    if (ch === '"') {
      i = skipString(text, i)
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/** Offset just past the `>>>` that closes a heredoc command, or -1. */
function findHeredocEnd(text: string, from: number): number {
  const idx = text.indexOf('>>>', from)
  return idx === -1 ? -1 : idx + 3
}

/**
 * Skip whitespace and comments.
 *
 * Exported (with `readQualifiedName`) for `findCallAtOffset` in definition.ts,
 * which re-derives a call's qualified-target span with the exact same readers
 * the scan uses — an aliased call stores the *alias* span in `nameStart/nameEnd`.
 */
export function skipTrivia(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (isSpace(ch)) {
      i++
    } else if (ch === '#') {
      i = skipLineComment(text, i)
    } else {
      break
    }
  }
  return i
}

function readWord(text: string, from: number): { value: string; end: number } {
  let i = from
  while (i < text.length && isWordChar(text[i])) i++
  return { value: text.slice(from, i), end: i }
}

/** Read a possibly-dotted name such as `lib.task`. See `skipTrivia` for why exported. */
export function readQualifiedName(text: string, from: number): { value: string; end: number } {
  const first = readWord(text, from)
  let value = first.value
  let end = first.end
  while (text[end] === '.') {
    const next = readWord(text, end + 1)
    if (!next.value) break
    value += '.' + next.value
    end = next.end
  }
  return { value, end }
}

/**
 * Scan a whole document. Blocks are returned in document order (pre-order), so
 * `parent` always refers to an earlier index.
 *
 * Malformed input never throws: unbalanced braces simply truncate the affected
 * block at EOF.
 */
export function scanDocument(text: string): ScannedBlock[] {
  const out: ScannedBlock[] = []
  scanRange(text, 0, text.length, 0, -1, out)
  return out
}

function scanRange(
  text: string,
  start: number,
  end: number,
  depth: number,
  parent: number,
  out: ScannedBlock[]
): void {
  let i = start

  while (i < end) {
    const ch = text[i]

    if (ch === '#') {
      i = skipLineComment(text, i)
      continue
    }
    if (ch === '"') {
      i = skipString(text, i)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      // An unrecognised group (map/object literal, expression) — step over it so
      // its contents cannot be mistaken for declarations.
      const close = ch === '{' ? '}' : ch === '(' ? ')' : ']'
      const matched = matchBracket(text, i, ch, close)
      i = matched === -1 ? end : matched
      continue
    }
    if (!isWordStart(ch)) {
      i++
      continue
    }

    const word = readWord(text, i)
    const keyword = word.value

    if (!CONTAINER_KEYWORDS.has(keyword) && !OPAQUE_KEYWORDS.has(keyword)) {
      i = word.end
      continue
    }

    const block = readBlock(text, keyword, i, word.end, end)
    if (block === null) {
      // Keyword used in an expression position (e.g. `input:` inside a call, or
      // `object` as an identifier) — keep scanning from just past the word.
      i = word.end
      continue
    }

    block.depth = depth
    block.parent = parent
    const index = out.length
    out.push(block)

    if (block.hasBody && CONTAINER_KEYWORDS.has(keyword)) {
      scanRange(text, block.bodyStart, block.end - 1, depth + 1, index, out)
    }

    i = block.end
  }
}

/** The common initial state every block shares; per-kind readers fill the rest. */
function blockBase(keyword: string, keywordStart: number, keywordEnd: number): ScannedBlock {
  return {
    kind: keyword as BlockKind,
    name: null,
    alias: null,
    header: null,
    start: keywordStart,
    end: keywordEnd,
    nameStart: -1,
    nameEnd: -1,
    bodyStart: -1,
    braceStart: -1,
    depth: 0,
    parent: -1,
    hasBody: false,
  }
}

/**
 * Try to read a block opened by `keyword` at `keywordStart`. Returns null when
 * the keyword is not actually opening a block here.
 */
function readBlock(
  text: string,
  keyword: string,
  keywordStart: number,
  keywordEnd: number,
  limit: number
): ScannedBlock | null {
  const base = blockBase(keyword, keywordStart, keywordEnd)
  const cursor = skipTrivia(text, keywordEnd)

  switch (keyword) {
    case 'command':
      return readCommandBlock(text, base, cursor, limit)
    case 'if':
    case 'scatter':
      return readControlBlock(text, base, cursor, limit)
    case 'call':
      return readCallBlock(text, base, cursor, limit)
    default:
      return readNamedBlock(text, base, keyword, cursor, limit)
  }
}

/** `command`: a `<<< … >>>` heredoc or a `{ … }` brace body (opaque shell text). */
function readCommandBlock(
  text: string,
  base: ScannedBlock,
  cursor: number,
  limit: number
): ScannedBlock | null {
  if (text.startsWith('<<<', cursor)) {
    const heredocEnd = findHeredocEnd(text, cursor + 3)
    if (heredocEnd === -1 || heredocEnd > limit) return null
    return { ...base, end: heredocEnd, hasBody: true, bodyStart: cursor + 3 }
  }
  if (text[cursor] === '{') {
    const close = matchBracket(text, cursor, '{', '}')
    if (close === -1 || close > limit) return null
    return { ...base, end: close, braceStart: cursor, bodyStart: cursor + 1, hasBody: true }
  }
  return null
}

/** `if (…) { … }` / `scatter (…) { … }` — the header is the parenthesised expr. */
function readControlBlock(
  text: string,
  base: ScannedBlock,
  cursor: number,
  limit: number
): ScannedBlock | null {
  if (text[cursor] !== '(') return null
  const parenEnd = matchBracket(text, cursor, '(', ')')
  if (parenEnd === -1 || parenEnd > limit) return null
  const header = text.slice(cursor + 1, parenEnd - 1).trim()
  const afterParen = skipTrivia(text, parenEnd)
  if (text[afterParen] !== '{') return null
  const close = matchBracket(text, afterParen, '{', '}')
  if (close === -1 || close > limit) return null
  return {
    ...base,
    header,
    end: close,
    braceStart: afterParen,
    bodyStart: afterParen + 1,
    hasBody: true,
  }
}

/** `call name [as alias] [{ … }]` — the alias span is stored in `nameStart/nameEnd`. */
function readCallBlock(
  text: string,
  base: ScannedBlock,
  cursor: number,
  limit: number
): ScannedBlock | null {
  const name = readQualifiedName(text, cursor)
  if (!name.value) return null
  let afterName = name.end
  let alias: string | null = null
  let aliasStart = -1

  const maybeAs = skipTrivia(text, afterName)
  const asWord = readWord(text, maybeAs)
  if (asWord.value === 'as') {
    const aliasPos = skipTrivia(text, asWord.end)
    const aliasWord = readWord(text, aliasPos)
    if (aliasWord.value) {
      alias = aliasWord.value
      aliasStart = aliasPos
      afterName = aliasWord.end
    }
  }

  // An aliased call stores the *alias* span so outline/reveal select `alias`
  // rather than the fully-qualified target; `definition.ts` re-derives the
  // target span itself via `skipTrivia`/`readQualifiedName`.
  const nameStart = alias !== null ? aliasStart : cursor
  const nameEnd = alias !== null ? aliasStart + alias.length : name.end

  const bracePos = skipTrivia(text, afterName)
  if (text[bracePos] === '{') {
    const close = matchBracket(text, bracePos, '{', '}')
    if (close === -1 || close > limit) return null
    return {
      ...base,
      name: name.value,
      alias,
      nameStart,
      nameEnd,
      end: close,
      braceStart: bracePos,
      bodyStart: bracePos + 1,
      hasBody: true,
    }
  }

  // Anything else means a bare `call foo` with no argument list. `skipTrivia`
  // above may have stepped over line breaks (WDL permits the brace to sit on
  // the next line), so the statement still ends at the break following the
  // name — not at whatever token the trivia skip landed on.
  return {
    ...base,
    name: name.value,
    alias,
    nameStart,
    nameEnd,
    // Clamped: a bare call on the same line as its parent's `}` has no newline
    // to stop at, and must not swallow the enclosing block's brace.
    end: Math.min(endOfLine(text, afterName), limit),
    hasBody: false,
  }
}

/** `workflow`/`task`/`struct` (named) and `input`/`output`/`runtime`/`meta`/`parameter_meta` (anonymous). */
function readNamedBlock(
  text: string,
  base: ScannedBlock,
  keyword: string,
  cursor: number,
  limit: number
): ScannedBlock | null {
  let name: string | null = null
  let nameStart = -1
  let nameEnd = -1

  if (keyword === 'workflow' || keyword === 'task' || keyword === 'struct') {
    const word = readWord(text, cursor)
    if (!word.value) return null
    name = word.value
    nameStart = cursor
    nameEnd = word.end
    cursor = word.end
  }

  const bracePos = skipTrivia(text, cursor)
  if (text[bracePos] !== '{') return null
  const close = matchBracket(text, bracePos, '{', '}')
  if (close === -1 || close > limit) return null

  return {
    ...base,
    name,
    nameStart,
    nameEnd,
    end: close,
    braceStart: bracePos,
    bodyStart: bracePos + 1,
    hasBody: true,
  }
}

/**
 * Convenience: the display name used by Outline for a block.
 *
 * Calls keep their `call` prefix so that `call align` in a workflow is visibly
 * distinct from the `align` task defined further down the file.
 */
export function blockDisplayName(block: ScannedBlock): string {
  switch (block.kind) {
    case 'call': {
      const target = block.alias ?? block.name
      return target ? `call ${target}` : 'call'
    }
    case 'if':
      return `if (${block.header ?? '…'})`
    case 'scatter':
      return `scatter (${block.header ?? '…'})`
    default:
      return block.name ?? block.kind
  }
}
