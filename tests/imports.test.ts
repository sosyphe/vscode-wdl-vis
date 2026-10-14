// parseImports is lexical: the interesting cases are the ones where the word
// `import` appears somewhere it must NOT be treated as an import statement
// (command bodies, meta blocks, comments), and the path/alias normalizations
// go-to-definition relies on.

import { describe, expect, it } from 'vitest'

import { parseImports, joinPosix, dirName, hasUriScheme, resolveImportPath } from '../src/language/imports'
import { scanDocument } from '../src/language/scanner'
import { SAMPLE } from './fixtures'

function importsOf(text: string) {
  return parseImports(text, scanDocument(text))
}

describe('parseImports', () => {
  it('finds the repository fixture import with its alias', () => {
    expect(importsOf(SAMPLE)).toEqual([{ path: 'lib.wdl', alias: 'lib', defaultAlias: 'lib' }])
  })

  it('supports several imports, explicit and default aliases, both quote styles', () => {
    const text = [
      'version 1.1',
      '',
      'import "tasks/align.wdl" as aligner',
      "import '../shared/util.wdl'",
      'import "lib.wdl" as lib',
      '',
      'workflow w { call aligner.go }',
      '',
    ].join('\n')

    expect(importsOf(text)).toEqual([
      { path: 'tasks/align.wdl', alias: 'aligner', defaultAlias: 'align' },
      { path: '../shared/util.wdl', alias: null, defaultAlias: 'util' },
      { path: 'lib.wdl', alias: 'lib', defaultAlias: 'lib' },
    ])
  })

  it('accepts a trailing comment but nothing else after the statement', () => {
    const text = [
      'import "a.wdl" as a # the a library',
      'import "b.wdl" as b   ',
      'import "c.wdl" trailing junk',
      '',
    ].join('\n')

    expect(importsOf(text).map((i) => i.path)).toEqual(['a.wdl', 'b.wdl'])
  })

  it('ignores commented-out imports', () => {
    expect(importsOf('# import "gone.wdl" as gone\nversion 1.1\n')).toEqual([])
  })

  it('keeps a remote import verbatim — resolution decides what to do with it', () => {
    const text = 'import "https://example.com/tools.wdl" as tools\n'
    expect(importsOf(text)).toEqual([
      { path: 'https://example.com/tools.wdl', alias: 'tools', defaultAlias: 'tools' },
    ])
  })

  it('rejects `import` inside a heredoc command body', () => {
    const text = [
      'task shell_task {',
      '  command <<<',
      '    import "fake.wdl" as fake',
      '    python -c "import os"',
      '  >>>',
      '}',
      'import "real.wdl" as real',
      '',
    ].join('\n')

    expect(importsOf(text)).toEqual([{ path: 'real.wdl', alias: 'real', defaultAlias: 'real' }])
  })

  it('rejects `import` inside a brace command body and inside meta blocks', () => {
    const text = [
      'import "top.wdl" as top',
      '',
      'task brace_task {',
      '  command {',
      "    import 'also.wdl' as nope",
      '  }',
      '  meta {',
      '    notes: "import \\"meta.wdl\\" as meta_ns"',
      '  }',
      '}',
      '',
    ].join('\n')

    expect(importsOf(text).map((i) => i.path)).toEqual(['top.wdl'])
  })

  it('skips empty import paths', () => {
    expect(importsOf('import "" as empty\n')).toEqual([])
  })
})

// The containment check tests only `depth === 0` blocks. That is valid because
// every block's range sits inside its top-level ancestor's — but it is a real
// change from testing all of them, so these pin the equivalence on genuine
// nesting rather than trusting the argument.
describe('parseImports containment at depth 0', () => {
  it('rejects an import nested several levels inside a workflow', () => {
    const text = [
      'version 1.0',
      'workflow w {',
      '  scatter (x in xs) {',
      '    if (x) {',
      '      call t {',
      '        input:',
      '          import "nested.wdl" as nested',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n')

    expect(importsOf(text)).toEqual([])
  })

  it('rejects an import inside a struct body', () => {
    const text = [
      'version 1.0',
      'struct Config {',
      '  import "in_struct.wdl" as s',
      '  String name',
      '}',
      '',
    ].join('\n')

    expect(importsOf(text)).toEqual([])
  })

  it('finds top-level imports both before and after a block', () => {
    // This is why the scan cannot simply stop at the first block: degraded but
    // readable input puts a stray import after a declaration, and dropping it
    // would break go-to-definition for every call in that namespace.
    const text = [
      'version 1.0',
      'import "before.wdl" as before',
      'task t {',
      '  command { true }',
      '}',
      'import "after.wdl" as after',
      '',
    ].join('\n')

    expect(importsOf(text).map((i) => i.path)).toEqual(['before.wdl', 'after.wdl'])
  })

  it('mixes all three: two real imports and three decoys inside blocks', () => {
    const text = [
      'import "real_one.wdl" as one',
      'workflow w {',
      '  call t {',
      '    input:',
      '      import "decoy_nested.wdl" as d1',
      '  }',
      '}',
      'task t {',
      '  command <<<',
      '    import "decoy_heredoc.wdl" as d2',
      '  >>>',
      '  meta {',
      '    notes: "import \\"decoy_meta.wdl\\" as d3"',
      '  }',
      '}',
      'import "real_two.wdl" as two',
      '',
    ].join('\n')

    expect(importsOf(text).map((i) => i.path)).toEqual(['real_one.wdl', 'real_two.wdl'])
  })
})

describe('hasUriScheme', () => {
  it.each([
    ['https://example.com/a.wdl', true],
    ['http://example.com/a.wdl', true],
    ['s3://bucket/a.wdl', true],
    ['lib.wdl', false],
    ['./lib.wdl', false],
    ['/abs/lib.wdl', false],
    ['C:/windows-ish/lib.wdl', false], // no `//` — treated as a relative path
  ])('%s → %s', (path, expected) => {
    expect(hasUriScheme(path)).toBe(expected)
  })
})

describe('dirName', () => {
  it.each([
    ['/ws/a/b.wdl', '/ws/a'],
    ['/b.wdl', '/'],
    ['b.wdl', '/'],
    ['/ws/a/', '/ws/a'],
  ])('%s → %s', (path, expected) => {
    expect(dirName(path)).toBe(expected)
  })
})

describe('resolveImportPath', () => {
  it.each([
    ['sibling import stays in the same directory', '/ws/main.wdl', 'tasks.wdl', '/ws/tasks.wdl'],
    ['relative import climbs up', '/ws/sub/main.wdl', '../shared/tasks.wdl', '/ws/shared/tasks.wdl'],
    ['nested relative import', '/ws/a/b/main.wdl', '../../x.wdl', '/ws/x.wdl'],
    ['absolute import wins outright', '/ws/main.wdl', '/abs/x.wdl', '/abs/x.wdl'],
  ])('%s', (_label, base, rel, expected) => {
    expect(resolveImportPath(base, rel)).toBe(expected)
  })
})

describe('joinPosix', () => {
  it.each([
    ['../lib.wdl climbs out of the base directory', '/ws/sub', '../lib.wdl', '/ws/lib.wdl'],
    ['./ is collapsed', '/ws', './a/b.wdl', '/ws/a/b.wdl'],
    ['nested .. segments', '/ws/a/b/c', '../../x.wdl', '/ws/a/x.wdl'],
    ['an absolute rel wins outright', '/ws/sub', '/abs/x.wdl', '/abs/x.wdl'],
    ['duplicate slashes collapse', '/ws//sub/', 'a//b.wdl', '/ws/sub/a/b.wdl'],
    ['.. never climbs past the root', '/', '../escaped.wdl', '/escaped.wdl'],
    ['unmatched .. in a relative dir stays relative', 'sub', '../a.wdl', 'a.wdl'],
  ])('%s', (_label, dir, rel, expected) => {
    expect(joinPosix(dir, rel)).toBe(expected)
  })
})
