// Definition provider: Ctrl+click / F12 on a `call`'s target name — or its
// alias — jumps to the task or sub-workflow it invokes, in the same file or in
// the imported file behind a namespace.
//
// All scanning and resolution is pure and unit tested (scanner.ts,
// definition.ts, imports.ts); this file is the thin vscode adapter. Unlike the
// graph-webview click path, unresolvable targets return `undefined` *silently*:
// a stray F12 in the editor is common, and VS Code's own "No definition found"
// is the idiomatic answer there — a warning popup would be noise.
//
// Both constructor arguments are optional with working defaults, so the class
// can still be built bare (`new WdlDefinitionProvider()`) — which is what the
// unit tests do. `activate()` injects the instances shared with the symbol and
// folding providers.
//
// The cache is what makes this cheap. VS Code calls a definition provider
// several times per gesture: link detection fires on every mouse move while Ctrl
// is held, then the click itself resolves again. Scanning a 113 KB document
// each time — twice, since `definitionRange` used to re-scan — is what made
// Ctrl+click feel heavy on a large WDL file. With the shared `ScanCache` a
// repeated call on an unedited document does no scanning at all.

import * as vscode from 'vscode'

import { definitionRange, findCallAtOffset, resolveQualified } from '../language/definition'
import { resolveImportPath } from '../language/imports'
import { ScanCache } from '../language/scanCache'
import { nullTracer } from '../util/tracer'
import type { Tracer } from '../util/tracer'
import type { OffsetRange } from '../language/outline'

export class WdlDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly cache: ScanCache = new ScanCache(),
    private readonly tracer: Tracer = nullTracer
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Location | undefined> {
    const span = this.tracer.span('provideDefinition')
    const uri = document.uri.toString()

    span.mark('getText')
    const text = document.getText()

    span.mark('scan')
    const blocks = this.cache.blocksFor(uri, document.version, text)

    span.mark('findCall')
    const call = findCallAtOffset(text, blocks, document.offsetAt(position))
    if (!call || call.name === null) {
      span.stop('no call at cursor')
      return undefined
    }

    span.mark('resolve')
    // The thunk keeps `parseImports` off the common path entirely: it runs only
    // for a dotted `call lib.task`, and then only once per document version.
    const resolution = resolveQualified(text, blocks, call.name, () =>
      this.cache.importsFor(uri, document.version, text, blocks)
    )

    if (resolution.type === 'same-file') {
      span.mark('definitionRange')
      const range = definitionRange(text, resolution.taskName, blocks)
      span.stop(`same-file ${resolution.taskName}`)
      return toLocation(document, range)
    }

    if (resolution.type === 'imported') {
      const targetUri = document.uri.with({
        path: resolveImportPath(document.uri.path, resolution.importPath),
      })

      span.mark('openTarget')
      let target: vscode.TextDocument
      try {
        target = await vscode.workspace.openTextDocument(targetUri)
      } catch {
        span.stop(`import target missing: ${resolution.importPath}`)
        return undefined // the import points at a missing or deleted file
      }

      span.mark('targetRange')
      const targetText = target.getText()
      // Through the same cache: the target is often already open, and a second
      // click on the same import then costs nothing.
      const targetBlocks = this.cache.blocksFor(
        target.uri.toString(),
        target.version,
        targetText
      )
      const range = definitionRange(targetText, resolution.taskName, targetBlocks)
      span.stop(`imported ${resolution.importPath} → ${resolution.taskName}`)
      return toLocation(target, range)
    }

    // Unknown namespace or remote (https://, s3://) import — nothing to open.
    span.stop(`unresolved: ${resolution.reason}`)
    return undefined
  }
}

function toLocation(
  document: vscode.TextDocument,
  range: OffsetRange | null
): vscode.Location | undefined {
  if (!range) return undefined // no task/workflow with that name in the target
  return new vscode.Location(
    document.uri,
    new vscode.Range(document.positionAt(range.start), document.positionAt(range.end))
  )
}
