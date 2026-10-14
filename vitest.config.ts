// Unit tests run in plain Node — no Extension Host, no @vscode/test-electron.
//
// `vscode` is not a real package, it is injected by the runtime, so it is aliased
// to a hand-written stub. Only the surface the providers actually touch is
// implemented; see tests/mocks/vscode.ts.
//
// Note: the *pure* modules (scanner/outline/fold/reveal/protocol/debounce/
// webviewHtml) import nothing from `vscode` at all, which is why the bulk of the
// suite would still pass without this alias.
//
// `wdl-viewer` and its stylesheet are aliased to stubs for the same reason: the
// real package is `file:`-linked and not built here, so the webview test mocks
// the Vue component instead of loading the parser/DAG/dagre.

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const stub = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: stub('./tests/mocks/vscode.ts') },
      { find: /^wdl-viewer$/, replacement: stub('./tests/mocks/wdl-viewer.ts') },
      { find: /^wdl-viewer\/style\.css$/, replacement: stub('./tests/mocks/wdl-style.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
