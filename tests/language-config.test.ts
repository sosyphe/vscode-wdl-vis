import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { KEYWORDS } from 'wdl-viewer/parser'

const CONFIG_PATH = fileURLToPath(new URL('../language-configuration.json', import.meta.url))

interface AutoClosingPair {
  open: string
  close: string
  notIn?: string[]
}

interface LanguageConfig {
  comments: { lineComment?: string; blockComment?: [string, string] }
  brackets: [string, string][]
  autoClosingPairs: AutoClosingPair[]
  surroundingPairs: (string | [string, string])[]
  folding: { offSide: boolean; markers: { start: string; end: string } }
  indentationRules: { increaseIndentPattern: string; decreaseIndentPattern: string }
  wordPattern: string
  onEnterRules: { beforeText: string; action: { indent: string } }[]
}

function loadConfig(): LanguageConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as LanguageConfig
}

describe('language-configuration.json', () => {
  const config = loadConfig()

  it('is valid JSON', () => {
    expect(config).toBeTypeOf('object')
  })

  it('declares # as the line comment so the toggle-comment keybinding works', () => {
    expect(config.comments.lineComment).toBe('#')
    // WDL has no block comments; claiming one would let Ctrl+Shift+A insert junk.
    expect(config.comments.blockComment).toBeUndefined()
  })

  it('pairs the brackets WDL actually uses', () => {
    expect(config.brackets).toEqual([
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ])
    // `<<<` / `>>>` are deliberately absent: treating them as brackets would make
    // VS Code try to auto-close them inside expressions and heredoc bodies.
    const flattened = config.brackets.flat()
    expect(flattened).not.toContain('<<<')
    expect(flattened).not.toContain('>>>')
  })

  it('auto-closes brackets and quotes, but not quotes inside a string', () => {
    const opens = config.autoClosingPairs.map((pair) => pair.open)
    expect(opens).toEqual(['{', '[', '(', '"'])

    const quote = config.autoClosingPairs.find((pair) => pair.open === '"')!
    expect(quote.close).toBe('"')
    expect(quote.notIn).toEqual(['string'])
  })

  it('offers surrounding pairs for the quote-and-bracket selection commands', () => {
    expect(config.surroundingPairs).toHaveLength(4)
  })

  it('compiles every regex it declares', () => {
    const patterns = [
      config.folding.markers.start,
      config.folding.markers.end,
      config.indentationRules.increaseIndentPattern,
      config.indentationRules.decreaseIndentPattern,
      config.wordPattern,
      ...config.onEnterRules.map((rule) => rule.beforeText),
    ]
    for (const pattern of patterns) {
      expect(() => new RegExp(pattern), pattern).not.toThrow()
    }
  })

  it('folds on every block-opening keyword the parser knows', () => {
    const start = new RegExp(config.folding.markers.start)
    // `version` opens the file rather than a block, but folding it is harmless
    // and matches the grammar; every real keyword must be there.
    const blockKeywords = [...KEYWORDS].filter((word) =>
      ['workflow', 'task', 'struct', 'if', 'scatter', 'input', 'output', 'runtime', 'meta', 'parameter_meta', 'command'].includes(word)
    )
    expect(blockKeywords.length).toBeGreaterThan(8)
    for (const keyword of blockKeywords) {
      expect(start.test(`  ${keyword} {`), keyword).toBe(true)
    }
    // A keyword appearing mid-expression must not start a fold.
    expect(start.test('  Int inputCount = 1')).toBe(false)
  })

  it('ends a fold on a closing brace or a heredoc terminator', () => {
    const end = new RegExp(config.folding.markers.end)
    expect(end.test('}')).toBe(true)
    expect(end.test('  >>>')).toBe(true)
    expect(end.test('  echo done')).toBe(false)
  })

  it('uses brace-based folding, not indentation-based', () => {
    expect(config.folding.offSide).toBe(false)
  })

  it('indents after an opening brace or a heredoc opener, and outdents on the closers', () => {
    const increase = new RegExp(config.indentationRules.increaseIndentPattern)
    const decrease = new RegExp(config.indentationRules.decreaseIndentPattern)

    expect(increase.test('workflow w {')).toBe(true)
    expect(increase.test('  command <<<')).toBe(true)
    expect(increase.test('  Int x = 1')).toBe(false)

    expect(decrease.test('}')).toBe(true)
    expect(decrease.test('  >>>')).toBe(true)
    expect(decrease.test('  } # trailing')).toBe(false)
  })

  it('treats a dotted call target as one word', () => {
    // Double-clicking `lib.align` should select all of it.
    const words = new RegExp(config.wordPattern, 'g')
    expect('call lib.align as aligned'.match(words)).toEqual([
      'call',
      'lib.align',
      'as',
      'aligned',
    ])
  })

  it('keeps the indent level when continuing a comment line', () => {
    expect(config.onEnterRules).toHaveLength(1)
    expect(config.onEnterRules[0].beforeText).toBe('^\\s*#')
    expect(config.onEnterRules[0].action.indent).toBe('none')
  })
})
