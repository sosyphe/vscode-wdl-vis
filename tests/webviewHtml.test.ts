import { describe, expect, it } from 'vitest'

import { buildWebviewHtml } from '../src/graph/webviewHtml'
import type { UriLike, WebviewLike } from '../src/graph/webviewHtml'

function uri(path: string): UriLike {
  return { toString: () => `file://${path}` }
}

function stubWebview(): WebviewLike & { requested: string[] } {
  const requested: string[] = []
  return {
    requested,
    cspSource: 'https://file.vscode-cdn.net',
    asWebviewUri(localResource: UriLike) {
      requested.push(localResource.toString())
      return { toString: () => `https://file.vscode-cdn.net${localResource.toString().slice(7)}` }
    },
  }
}

function render(overrides: Partial<Parameters<typeof buildWebviewHtml>[0]> = {}) {
  const webview = stubWebview()
  const html = buildWebviewHtml({
    webview,
    nonce: 'abc123',
    title: 'WDL Graph — sample.wdl',
    resources: {
      script: uri('/ext/dist/webview.js'),
      libraryCss: uri('/ext/dist/webview.css'),
      themeCss: uri('/ext/dist/theme.css'),
    },
    ...overrides,
  })
  return { html, webview }
}

describe('buildWebviewHtml', () => {
  it('locks scripts to the nonce and nothing else', () => {
    const { html } = render()
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-abc123'")
    expect(html).toContain('<script type="module" nonce="abc123"')
    // No second, un-nonced script tag.
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('scopes every other directive to the webview origin', () => {
    const { html } = render()
    expect(html).toContain('style-src https://file.vscode-cdn.net')
    expect(html).toContain('font-src https://file.vscode-cdn.net')
    expect(html).toContain('img-src https://file.vscode-cdn.net https: data:')
  })

  it('links all three media resources as webview URIs', () => {
    const { html, webview } = render()
    expect(webview.requested).toEqual([
      'file:///ext/dist/webview.js',
      'file:///ext/dist/webview.css',
      'file:///ext/dist/theme.css',
    ])
    expect(html).toContain('href="https://file.vscode-cdn.net/ext/dist/webview.css"')
    expect(html).toContain('href="https://file.vscode-cdn.net/ext/dist/theme.css"')
    expect(html).toContain('src="https://file.vscode-cdn.net/ext/dist/webview.js"')
  })

  it('loads the theme stylesheet after the library one so overrides win', () => {
    const { html } = render()
    expect(html.indexOf('webview.css')).toBeLessThan(html.indexOf('theme.css'))
  })

  it('mounts the Vue app into #app', () => {
    expect(render().html).toContain('<div id="app"></div>')
  })

  it('escapes the title', () => {
    const { html } = render({ title: 'a <b> & "c"' })
    expect(html).toContain('<title>a &lt;b&gt; &amp; &quot;c&quot;</title>')
    expect(html).not.toContain('<b>')
  })

  it('produces a different document for a different nonce', () => {
    expect(render().html).not.toBe(render({ nonce: 'other' }).html)
  })
})
