// Provider tests: the thin adapters between the pure logic modules and VS Code.
// They run against tests/mocks/vscode.ts — no Extension Host involved.

import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { WdlOutlineProvider } from '../src/providers/outlineProvider'
import { WdlFoldProvider } from '../src/providers/foldProvider'
import { SymbolKind, createTextDocument } from './mocks/vscode'

// The mock is structurally compatible but not nominally identical to the real
// API, so it is cast once here rather than at every call site.
function document(text: string): vscode.TextDocument {
  return createTextDocument(text) as unknown as vscode.TextDocument
}

const TOKEN = {} as vscode.CancellationToken
const FOLD_CONTEXT = {
  includeIndentation: false,
  includeComment: false,
  includeImports: false,
} as vscode.FoldingContext

/** task at 2–6, command at 3–5. */
const TASK_TEXT = [
  'version 1.0', // 0
  '', //  1
  'task t {', //  2
  '  command {', //  3
  '    echo hi', //  4
  '  }', //  5
  '}', //  6
  '', //  7
].join('\n')

describe('WdlOutlineProvider', () => {
  const provider = new WdlOutlineProvider()

  it('returns one symbol per top-level block, nested correctly', () => {
    const symbols = provider.provideDocumentSymbols(document(TASK_TEXT), TOKEN)

    expect(symbols).toHaveLength(1)
    expect(symbols[0].name).toBe('t')
    expect(symbols[0].children.map((child) => child.name)).toEqual(['command'])
    expect(symbols[0].children[0].children).toEqual([])
  })

  it('maps block kinds onto symbol kinds', () => {
    const text = [
      'workflow w {',
      '  input { Int x }',
      '  scatter (i in xs) {',
      '    call helper',
      '  }',
      '  output { Int y = 1 }',
      '}',
      '',
      'struct S { Int a }',
      '',
      'task helper {',
      '  command { true }',
      '  runtime { docker: "x" }',
      '}',
      '',
    ].join('\n')

    const symbols = provider.provideDocumentSymbols(document(text), TOKEN)
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]))

    expect(byName.get('w')!.kind).toBe(SymbolKind.Namespace)
    expect(byName.get('S')!.kind).toBe(SymbolKind.Struct)
    expect(byName.get('helper')!.kind).toBe(SymbolKind.Function)

    const children = new Map(byName.get('w')!.children.map((c) => [c.name, c]))
    expect(children.get('input')!.kind).toBe(SymbolKind.Struct)
    expect(children.get('output')!.kind).toBe(SymbolKind.Struct)
    expect(children.get('scatter (i in xs)')!.kind).toBe(SymbolKind.Object)

    const scatterChildren = children.get('scatter (i in xs)')!.children
    expect(scatterChildren.map((c) => c.name)).toEqual(['call helper'])
    expect(scatterChildren[0].kind).toBe(SymbolKind.Method)

    const taskChildren = new Map(byName.get('helper')!.children.map((c) => [c.name, c]))
    expect(taskChildren.get('command')!.kind).toBe(SymbolKind.Method)
    expect(taskChildren.get('runtime')!.kind).toBe(SymbolKind.Object)
  })

  it('converts offsets into line/character ranges', () => {
    const [task] = provider.provideDocumentSymbols(document(TASK_TEXT), TOKEN)

    expect(task.range.start.line).toBe(2)
    expect(task.range.start.character).toBe(0)
    expect(task.range.end.line).toBe(6)
    expect(task.range.end.character).toBe(1)

    // The selection lands on the name, not the whole block.
    expect(task.selectionRange.start.line).toBe(2)
    expect(task.selectionRange.start.character).toBe(5)
    expect(task.selectionRange.end.character).toBe(6)
  })

  it('surfaces the aliased task as detail', () => {
    const text = 'workflow w {\n  call lib.t as aliased {\n    input: x = 1\n  }\n}\n'
    const [workflow] = provider.provideDocumentSymbols(document(text), TOKEN)
    const call = workflow.children[0]

    expect(call.name).toBe('call aliased')
    expect(call.detail).toBe('lib.t')
  })

  it('returns an empty list for a file with no blocks', () => {
    expect(provider.provideDocumentSymbols(document('version 1.0\n'), TOKEN)).toEqual([])
    expect(provider.provideDocumentSymbols(document(''), TOKEN)).toEqual([])
  })

  it('clamps offsets for a document without a trailing newline', () => {
    const text = 'workflow w {\n  input { Int x }\n}'
    const symbols = provider.provideDocumentSymbols(document(text), TOKEN)
    expect(symbols[0].range.end.line).toBe(2)
  })
})

describe('WdlFoldProvider', () => {
  const provider = new WdlFoldProvider()

  function foldLines(text: string): [number, number][] {
    return provider
      .provideFoldingRanges(document(text), FOLD_CONTEXT, TOKEN)
      .map((range) => [range.start, range.end])
  }

  it('folds a task from its keyword line to its closing brace line', () => {
    expect(foldLines(TASK_TEXT)).toEqual([
      [2, 6], // task t
      [3, 5], // command
    ])
  })

  it('omits single-line blocks, which have nothing to hide', () => {
    expect(foldLines('workflow w { input { Int x } }\n')).toEqual([])
    expect(foldLines('task t {\n  command { true }\n}\n')).toEqual([[0, 2]])
  })

  it('omits a bare call', () => {
    expect(foldLines('workflow w {\n  call helper\n}\n')).toEqual([[0, 2]])
  })

  it('ends a heredoc command at the >>> line', () => {
    const text = [
      'task t {', //        0
      '  command <<<', //   1
      '    echo "}"', //    2
      '  >>>', //             3
      '}', //                 4
      '', //                5
    ].join('\n')

    expect(foldLines(text)).toEqual([
      [0, 4],
      [1, 3],
    ])
  })

  it('returns nothing for an empty document', () => {
    expect(foldLines('')).toEqual([])
  })
})
