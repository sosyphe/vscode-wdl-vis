// Bundles the two (well, three) artifacts this extension ships:
//
//   dist/extension.js   extension host — CommonJS, runs in Node, `vscode` external
//   dist/webview.js     graph webview  — ESM, runs in a browser sandbox, inlines Vue
//   dist/webview.css    styles emitted from the `wdl-viewer/style.css` import
//   dist/theme.css      VS Code theme adaptation, loaded *after* webview.css
//
// Everything from `wdl-viewer` is inlined, so the .vsix needs no node_modules.

import * as esbuild from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const extRoot = resolve(scriptDir, '..')
const watch = process.argv.includes('--watch')

// Force every `vue` import in the graph to resolve to *this* package's copy, so
// the library and webview code share one Vue instance (two instances in one
// bundle silently break reactivity).
const require = createRequire(import.meta.url)
const vueDir = dirname(require.resolve('vue/package.json', { paths: [extRoot] }))

const common = {
  bundle: true,
  // Maps are a debugging aid while the Extension Host is running, and dead
  // weight (~1 MB) in a shipped .vsix. `vscode:prepublish` re-runs this script
  // without --watch, so packaging always produces map-free output.
  sourcemap: watch,
  logLevel: /** @type {const} */ ('warning'),
  absWorkingDir: extRoot,
}

/** Extension host: Node, CommonJS, `vscode` supplied by the runtime. */
const hostOptions = {
  ...common,
  entryPoints: [resolve(extRoot, 'src/extension.ts')],
  outfile: resolve(extRoot, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  define: { 'process.env.NODE_ENV': '"production"' },
}

/**
 * Graph webview: browser, ESM.
 *
 * ESM is required, not a preference: wdl-viewer's layout module uses a dynamic
 * `import('@dagrejs/dagre')`, and Vite's `__vitePreload` helper around it reads
 * `import.meta.url`. Under `format: 'iife'` esbuild replaces `import.meta` with
 * an empty object and the graph fails to lay out. The webview HTML loads this
 * file with `<script type="module">`.
 *
 * The `__VUE_*__` defines are mandatory — Vue's esm-bundler build references
 * them bare, and the webview has no bundler to inject them at runtime.
 */
const webviewOptions = {
  ...common,
  entryPoints: [resolve(extRoot, 'src/graph/webview/main.ts')],
  outfile: resolve(extRoot, 'dist/webview.js'),
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  alias: { vue: vueDir },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
}

/** Theme overrides kept separate so they cascade after the library CSS. */
const themeOptions = {
  ...common,
  entryPoints: [resolve(extRoot, 'src/graph/webview/theme.css')],
  outfile: resolve(extRoot, 'dist/theme.css'),
}

const allOptions = [hostOptions, webviewOptions, themeOptions]

if (watch) {
  for (const options of allOptions) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
  }
  console.log('[vscode-wdl-vis] watching for changes… (restart the Extension Host to pick up host changes)')
} else {
  await Promise.all(allOptions.map((options) => esbuild.build(options)))
  console.log('[vscode-wdl-vis] built dist/extension.js, dist/webview.js, dist/webview.css, dist/theme.css')
}
