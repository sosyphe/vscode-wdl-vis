// Builds the webview's HTML document: CSP, nonce-locked script tag, and the two
// stylesheets in load order (library CSS first, theme overrides second).
//
// The `vscode` types are referenced structurally rather than imported so this
// module can be unit-tested with a stub webview.

/** The slice of `vscode.Webview` used here. */
export interface WebviewLike {
  readonly cspSource: string
  asWebviewUri(localResource: UriLike): UriLike
}

/** The slice of `vscode.Uri` used here. */
export interface UriLike {
  toString(): string
}

export interface WebviewResources {
  /** `dist/webview.js` — the ESM bundle containing Vue + WdlViewer. */
  script: UriLike
  /** `dist/webview.css` — styles emitted by the library bundle. */
  libraryCss: UriLike
  /** `dist/theme.css` — VS Code theme adaptation; must load after `libraryCss`. */
  themeCss: UriLike
}

export interface WebviewHtmlOptions {
  webview: WebviewLike
  /** Random per-render token; must match the `nonce` attribute on the script tag. */
  nonce: string
  title: string
  resources: WebviewResources
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * `style-src` allows `'unsafe-inline'` because the graph positions its inspector
 * and tooltips through Vue `:style` bindings; `script-src` stays locked to the
 * nonce, which is the part that actually matters.
 */
function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ')
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { webview, nonce, title, resources } = options
  const script = webview.asWebviewUri(resources.script).toString()
  const libraryCss = webview.asWebviewUri(resources.libraryCss).toString()
  const themeCss = webview.asWebviewUri(resources.themeCss).toString()
  const csp = contentSecurityPolicy(webview.cspSource, nonce)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(libraryCss)}">
<link rel="stylesheet" href="${escapeHtml(themeCss)}">
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${escapeHtml(nonce)}" src="${escapeHtml(script)}"></script>
</body>
</html>
`
}
