// Cross-checks the TextMate grammar against the parser's own keyword tables.
//
// The point is drift detection: if `wdl-viewer` ever adds a keyword, this suite
// fails until the grammar learns about it too.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { KEYWORDS, TYPE_KEYWORDS } from 'wdl-viewer/parser'

const GRAMMAR_PATH = fileURLToPath(new URL('../syntaxes/wdl.tmLanguage.json', import.meta.url))

function loadGrammar(): unknown {
  return JSON.parse(readFileSync(GRAMMAR_PATH, 'utf8'))
}

interface GrammarNode {
  match?: string
  begin?: string
  end?: string
  include?: string
  patterns?: GrammarNode[]
  repository?: Record<string, GrammarNode>
  [key: string]: unknown
}

/** Every `include` target, recursively. External grammars look like `source.x`. */
function collectIncludes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectIncludes(item, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out

  const record = node as GrammarNode
  if (typeof record.include === 'string') out.push(record.include)
  if (record.patterns) collectIncludes(record.patterns, out)
  if (record.repository) collectIncludes(Object.values(record.repository), out)
  return out
}

/** Every regex the grammar can apply, collected recursively. */
function collectPatterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectPatterns(item, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out

  const record = node as GrammarNode
  for (const field of ['match', 'begin', 'end'] as const) {
    const value = record[field]
    if (typeof value === 'string') out.push(value)
  }
  if (record.patterns) collectPatterns(record.patterns, out)
  if (record.repository) collectPatterns(Object.values(record.repository), out)
  return out
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `word` occurs in any grammar regex as a standalone token rather than
 * as part of a longer identifier (`meta` must not match inside `parameter_meta`).
 */
function grammarMatchesWord(patterns: string[], word: string): boolean {
  const standalone = new RegExp(`(^|[^\\w-])${escapeRe(word)}([^\\w-]|$)`)
  return patterns.some((pattern) => standalone.test(pattern))
}

describe('wdl.tmLanguage.json', () => {
  const grammar = loadGrammar() as GrammarNode & {
    name: string
    scopeName: string
    fileTypes: string[]
    repository: Record<string, GrammarNode>
  }

  it('is valid JSON with the identity VS Code expects', () => {
    expect(grammar.name).toBe('WDL')
    expect(grammar.scopeName).toBe('source.wdl')
    expect(grammar.fileTypes).toEqual(['wdl'])
    expect(Array.isArray(grammar.patterns)).toBe(true)
  })

  it('compiles every regex it declares', () => {
    const patterns = collectPatterns(grammar)
    expect(patterns.length).toBeGreaterThan(20)
    for (const pattern of patterns) {
      expect(() => new RegExp(pattern), pattern).not.toThrow()
    }
  })

  it('covers every keyword the parser recognises', () => {
    const patterns = collectPatterns(grammar)
    const missing = [...KEYWORDS].filter((word) => !grammarMatchesWord(patterns, word))
    expect(missing).toEqual([])
  })

  it('covers every built-in type the parser recognises', () => {
    const patterns = collectPatterns(grammar)
    const missing = [...TYPE_KEYWORDS].filter((word) => !grammarMatchesWord(patterns, word))
    expect(missing).toEqual([])
  })

  it('anchors keyword and type patterns with word boundaries', () => {
    // Without \b, `Int` would also colour the tail of `Point` or `printInt`.
    expect(grammar.repository['control-keyword'].match).toMatch(/^\\b\(.*\)\\b$/)
    expect(grammar.repository['section-keyword'].match).toMatch(/^\\b\(.*\)\\b$/)
    expect(grammar.repository['type'].match).toContain('\\b(')
  })

  it('highlights the version declaration even though the parser treats it specially', () => {
    // `version` is deliberately absent from KEYWORDS — the grammar must still catch it.
    expect(KEYWORDS.has('version')).toBe(false)
    expect(grammar.repository['version-declaration'].match).toContain('version')
  })

  it('supports both command body forms', () => {
    expect(grammar.repository['command-block-heredoc'].begin).toContain('<<<')
    expect(grammar.repository['command-block-heredoc'].end).toContain('>>>')
    expect(grammar.repository['command-block-brace'].begin).toContain('\\{')
    expect(grammar.repository['command-block-brace'].end).toContain('\\}')
  })

  it('recurses through nested braces inside a brace command body', () => {
    // `awk '{print}'` must not terminate the command block early.
    const braceBlock = grammar.repository['command-block-brace']
    const includes = (braceBlock.patterns ?? []).map((p) => p.include)
    expect(includes).toContain('#command-brace-group')

    const group = grammar.repository['command-brace-group']
    expect((group.patterns ?? []).map((p) => p.include)).toContain('#command-brace-group')
  })

  it('recognises both ${} and ~{} placeholders inside strings and commands', () => {
    const placeholder = grammar.repository['placeholder']
    expect(placeholder.begin).toMatch(/\[~\$\]/)
    expect(placeholder.end).toBe('\\}')

    const stringIncludes = (grammar.repository['string'].patterns ?? []).map((p) => p.include)
    expect(stringIncludes).toContain('#placeholder')
    const heredocIncludes = (grammar.repository['command-block-heredoc'].patterns ?? []).map(
      (p) => p.include
    )
    expect(heredocIncludes).toContain('#placeholder')
  })

  it('colours placeholder content as a variable, never meta.embedded', () => {
    // VS Code's base themes force meta.embedded.* to the plain editor
    // foreground, which rendered ~{greeting} as flat black on light themes.
    // Never restore a meta.embedded.* contentName here.
    expect(grammar.repository['placeholder'].contentName).toBe('variable.other.readwrite.wdl')
  })

  it('does not embed shell highlighting (documented limitation)', () => {
    // WDL's ~{…} placeholders are not shell syntax, so injecting source.shell
    // would mis-tokenize them. If this ever changes, update the README too.
    const includes = collectIncludes(grammar)
    expect(includes.length).toBeGreaterThan(0)
    expect(includes.filter((target) => !target.startsWith('#'))).toEqual([])
    // The decision is recorded where a future reader will look for it.
    expect(JSON.stringify(grammar)).toContain('include: source.shell')
  })
})
