// The editor-side go-to-definition adapter: a cursor on a call's target name
// (or alias) must yield a Location — same document, or the imported file.
// Runs against tests/mocks/vscode.ts; the pure resolution logic behind it is
// covered in definition.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { WdlDefinitionProvider } from '../src/providers/definitionProvider'
import { ScanCache } from '../src/language/scanCache'
import {
  Position,
  __reset,
  createTextDocument,
  workspace as mockWorkspace,
} from './mocks/vscode'
import type { FakeTextDocument } from './mocks/vscode'
import { SAMPLE, lineOf } from './fixtures'

const provider = new WdlDefinitionProvider()
const TOKEN = {} as vscode.CancellationToken

/** Register a document with the mock workspace so `openTextDocument` resolves it. */
function register(text: string, uri: string): FakeTextDocument {
  const doc = createTextDocument(text, { uri })
  mockWorkspace.textDocuments.push(doc)
  return doc
}

/** Run the provider against `text`, cursor at `offset`. */
function defineAt(text: string, offset: number, uri = '/workspace/main.wdl') {
  const doc = createTextDocument(text, { uri })
  return provider.provideDefinition(
    doc as unknown as vscode.TextDocument,
    doc.positionAt(offset) as unknown as vscode.Position,
    TOKEN
  )
}

beforeEach(__reset)
afterEach(() => {
  vi.restoreAllMocks()
})

describe('same-file definitions', () => {
  const LOCAL = [
    'version 1.0', //   0
    '', //              1
    'workflow w {', //  2
    '  call helper', // 3
    '  call sub', //    4
    '}', //             5
    '', //              6
    'task helper {', // 7
    '  command { true }', // 8
    '}', //             9
    '', //             10
    'workflow sub {', // 11
    '  call helper', // 12
    '}', //            13
  ].join('\n')

  it('jumps from a call to the task header, with exact positions', async () => {
    const location = await defineAt(LOCAL, LOCAL.indexOf('call helper') + 6)

    expect(location).toBeDefined()
    expect(location!.uri.path).toBe('/workspace/main.wdl')
    expect(location!.range.start).toEqual(new Position(7, 0))
    // headerRange covers `task helper` — 11 characters on line 7.
    expect(location!.range.end).toEqual(new Position(7, 'task helper'.length))
  })

  it('jumps to a sub-workflow definition', async () => {
    const location = await defineAt(LOCAL, LOCAL.indexOf('call sub') + 6)

    expect(location!.uri.path).toBe('/workspace/main.wdl')
    expect(location!.range.start).toEqual(new Position(11, 0))
    expect(location!.range.end).toEqual(new Position(11, 'workflow sub'.length))
  })

  it('jumps from a bare call in the repository fixture', async () => {
    const location = await defineAt(SAMPLE, SAMPLE.indexOf('call report') + 6, '/workspace/sample.wdl')

    expect(location!.uri.path).toBe('/workspace/sample.wdl')
    expect(location!.range.start.line).toBe(lineOf(SAMPLE, SAMPLE.indexOf('task report')))
    expect(location!.range.start.character).toBe(0)
    expect(location!.range.end.character).toBe('task report'.length)
  })
})

describe('cross-file definitions', () => {
  const MAIN = [
    'version 1.1', //             0
    '', //                        1
    'import "lib.wdl" as lib', // 2
    '', //                        3
    'workflow main {', //         4
    '  call lib.align', //        5
    '}', //                       6
  ].join('\n')

  const LIB = [
    'version 1.1', //       0
    '', //                  1
    'task align {', //      2
    '  command { true }', // 3
    '}', //                 4
  ].join('\n')

  it('opens the imported file and lands on the task header', async () => {
    register(LIB, '/workspace/lib.wdl')
    const location = await defineAt(MAIN, MAIN.indexOf('lib.align') + 5)

    expect(location!.uri.path).toBe('/workspace/lib.wdl')
    expect(location!.range.start).toEqual(new Position(2, 0))
    expect(location!.range.end).toEqual(new Position(2, 'task align'.length))
  })

  it('also fires with the cursor on the namespace part', async () => {
    register(LIB, '/workspace/lib.wdl')
    const location = await defineAt(MAIN, MAIN.indexOf('lib.align') + 1)

    expect(location!.uri.path).toBe('/workspace/lib.wdl')
  })

  it('fires on both the target name and the alias of an aliased call', async () => {
    // SAMPLE nests `call lib.align as aligned` inside scatter + if.
    register(LIB, '/workspace/lib.wdl')
    const onTarget = await defineAt(SAMPLE, SAMPLE.indexOf('lib.align') + 5, '/workspace/sample.wdl')
    const onAlias = await defineAt(SAMPLE, SAMPLE.indexOf('as aligned') + 4, '/workspace/sample.wdl')

    expect(onTarget!.uri.path).toBe('/workspace/lib.wdl')
    expect(onTarget!.range.start).toEqual(new Position(2, 0))
    expect(onAlias!.uri.path).toBe('/workspace/lib.wdl')
    expect(onAlias!.range.start).toEqual(new Position(2, 0))
  })

  it('uses the file stem as namespace when the import has no alias', async () => {
    const main = ['import "tools.wdl"', 'workflow w {', '  call tools.x', '}'].join('\n')
    const tools = ['version 1.1', 'task x {', '  command { true }', '}'].join('\n')
    register(tools, '/workspace/tools.wdl')

    const location = await defineAt(main, main.indexOf('tools.x') + 6)

    expect(location!.uri.path).toBe('/workspace/tools.wdl')
    expect(location!.range.start).toEqual(new Position(1, 0))
  })

  it('normalizes ../ in the import path against the importing document', async () => {
    const main = ['import "../shared/tasks.wdl" as t', 'workflow w {', '  call t.x', '}'].join('\n')
    register('task x {\n  command { true }\n}\n', '/workspace/shared/tasks.wdl')

    const location = await defineAt(main, main.indexOf('t.x') + 2, '/workspace/sub/main.wdl')

    expect(location!.uri.path).toBe('/workspace/shared/tasks.wdl')
  })
})

describe('no definition', () => {
  const MAIN = [
    'version 1.1', //             0
    '', //                        1
    'import "lib.wdl" as lib', // 2
    '', //                        3
    'workflow main {', //         4
    '  call lib.align', //        5
    '}', //                       6
    '', //                        7
    'task local {', //            8
    '  command { true }', //      9
    '}', //                      10
  ].join('\n')

  it('returns undefined on the call keyword', async () => {
    expect(await defineAt(MAIN, MAIN.indexOf('call lib.align') + 1)).toBeUndefined()
  })

  it('returns undefined inside unrelated text (task header, import line)', async () => {
    expect(await defineAt(MAIN, MAIN.indexOf('task local') + 6)).toBeUndefined()
    expect(await defineAt(MAIN, MAIN.indexOf('import "lib.wdl"') + 9)).toBeUndefined()
  })

  it('returns undefined inside a comment mentioning a call', async () => {
    const text = 'workflow w {\n  # call helper soon\n  call helper\n}\n\ntask helper {\n  command { true }\n}\n'
    expect(await defineAt(text, text.indexOf('# call helper') + 2)).toBeUndefined()
  })

  it('returns undefined inside a call input body', async () => {
    expect(await defineAt(SAMPLE, SAMPLE.indexOf('reads = sample') + 2, '/workspace/sample.wdl')).toBeUndefined()
  })

  it('returns undefined for an unknown namespace, without throwing', async () => {
    const text = 'import "lib.wdl" as lib\nworkflow w { call nope.x }\n'
    expect(await defineAt(text, text.indexOf('nope.x') + 1)).toBeUndefined()
  })

  it('returns undefined for a remote import, without opening anything', async () => {
    const text = 'import "https://example.com/t.wdl" as t\nworkflow w { call t.x }\n'
    const openSpy = vi.spyOn(mockWorkspace, 'openTextDocument')

    expect(await defineAt(text, text.indexOf('t.x') + 1)).toBeUndefined()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('returns undefined when the imported file does not exist', async () => {
    // Nothing registered, so the mock openTextDocument rejects — the provider
    // must degrade silently, exactly like a missing file on disk.
    const text = 'import "gone.wdl" as g\nworkflow w { call g.x }\n'
    expect(await defineAt(text, text.indexOf('g.x') + 1)).toBeUndefined()
  })

  it('returns undefined when the imported file lacks the task', async () => {
    register('task other {\n  command { true }\n}\n', '/workspace/lib.wdl')
    expect(await defineAt(MAIN, MAIN.indexOf('lib.align') + 5)).toBeUndefined()
  })
})

// VS Code resolves a definition several times per Ctrl+click — link detection
// fires on every mouse move while the modifier is held, then the click resolves
// again — and the symbol provider runs on every cursor move for breadcrumbs.
// These cover the cache that keeps that from meaning a full rescan each time.
describe('shared scan cache', () => {
  const CACHED = [
    'version 1.0', //        0
    'workflow w {', //       1
    '  call helper', //      2
    '}', //                  3
    'task helper {', //      4
    '  command { true }', // 5
    '}', //                  6
  ].join('\n')

  /** The same workflow with a blank line inserted, so the task moves down one. */
  const SHIFTED = [
    'version 1.0', //        0
    '', //                   1
    'workflow w {', //       2
    '  call helper', //      3
    '}', //                  4
    'task helper {', //      5
    '  command { true }', // 6
    '}', //                  7
  ].join('\n')

  function providerWith(cache: ScanCache) {
    const instance = new WdlDefinitionProvider(cache)
    return (text: string, uri = '/workspace/main.wdl') => {
      const doc = createTextDocument(text, { uri })
      return instance.provideDefinition(
        doc as unknown as vscode.TextDocument,
        doc.positionAt(text.indexOf('call helper') + 'call '.length + 1) as unknown as vscode.Position,
        TOKEN
      )
    }
  }

  it('scans once for repeated resolutions of an unchanged document', async () => {
    const cache = new ScanCache()
    const resolve = providerWith(cache)

    const first = await resolve(CACHED)
    const second = await resolve(CACHED)

    expect(first).toBeDefined()
    expect(second!.range.start.line).toBe(first!.range.start.line)
    expect(cache.stats.misses).toBe(1) // one scan…
    expect(cache.stats.hits).toBe(1) // …reused by the second call
  })

  it('does not serve a stale scan when one URI is fed different texts', async () => {
    // The mocks pin `version` at 1, so a version-only key would return the
    // *first* document's blocks here and jump to the wrong line.
    const cache = new ScanCache()
    const resolve = providerWith(cache)

    const before = await resolve(CACHED)
    const after = await resolve(SHIFTED)

    expect(before!.range.start.line).toBe(4)
    expect(after!.range.start.line).toBe(5)
  })

  it('keeps separate documents separate', async () => {
    const cache = new ScanCache()
    const resolve = providerWith(cache)

    const a = await resolve(CACHED, '/workspace/a.wdl')
    const b = await resolve(SHIFTED, '/workspace/b.wdl')

    expect(a!.range.start.line).toBe(4)
    expect(b!.range.start.line).toBe(5)
    expect(cache.size).toBe(2)
  })

  it('resolves identically with and without a shared cache', async () => {
    // The cache must be an optimisation, not a behaviour change.
    const shared = await providerWith(new ScanCache())(CACHED)
    const bare = await defineAt(CACHED, CACHED.indexOf('call helper') + 6)

    expect(shared!.uri.path).toBe(bare!.uri.path)
    expect(shared!.range.start).toEqual(bare!.range.start)
    expect(shared!.range.end).toEqual(bare!.range.end)
  })
})
