// @vitest-environment jsdom
//
// The graph webview's browser-side behaviour was previously untested: the host
// message handler, background switching, parse-error banner and Ctrl/Cmd+click
// detection. This suite mounts `src/graph/webview/main.ts` for real in jsdom, with
// `wdl-viewer` (Vue + dagre + the parser) aliased to tests/mocks/wdl-viewer.ts
// and `acquireVsCodeApi` stubbed to capture outbound messages.
//
// `main.ts` runs its mount when imported, so each test boots a fresh DOM and
// module: `vi.resetModules` makes the module re-evaluate, and the aliased
// `wdl-viewer` stub is re-applied on every import.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

function hostMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }))
}

function dispatchPointer(type: 'pointerdown' | 'pointercancel', ctrlKey = false): void {
  window.dispatchEvent(new MouseEvent(type, { ctrlKey, bubbles: true }))
}

/** Fresh module + DOM + acquireVsCodeApi stub per test. Returns the post spy. */
async function bootWebview() {
  document.body.innerHTML = '<div id="app"></div>'
  // innerHTML above replaces children only; the background mode lives on the
  // body element itself, so it must be cleared explicitly between tests.
  document.body.removeAttribute('data-wdl-bg')
  const postMessage = vi.fn()
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage,
    getState: () => undefined,
    setState: () => {},
  }))
  vi.resetModules()
  await import('../src/graph/webview/main')
  return postMessage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('webview boot', () => {
  it('sends a ready message on load', async () => {
    const postMessage = await bootWebview()
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' })
  })
})

describe('host messages', () => {
  it('applies an update: text, file name and background', async () => {
    const postMessage = await bootWebview()
    hostMessage({ type: 'update', text: 'version 1.0', fileName: 'main.wdl', background: 'dark' })
    await nextTick()

    expect(document.querySelector('.wdl-webview-status__name')?.textContent).toBe('main.wdl')
    expect(document.body.dataset.wdlBg).toBe('dark')
    // A host update is not something the webview echoes back.
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'update' }))
  })

  it('ignores non-host messages', async () => {
    await bootWebview()
    hostMessage({ type: 'update', text: 'version 1.0', fileName: 'f.wdl', background: 'light' })
    await nextTick()
    hostMessage({ type: 'bogus', background: 'dark' })
    await nextTick()
    expect(document.body.dataset.wdlBg).toBe('light')
  })
})

describe('background switch', () => {
  it('posts backgroundSelect and applies the mode when a button is clicked', async () => {
    const postMessage = await bootWebview()
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.wdl-bg-switch button'))
    const light = buttons.find((b) => b.textContent === 'Light') as HTMLButtonElement
    light.click()
    await nextTick()

    expect(postMessage).toHaveBeenCalledWith({ type: 'backgroundSelect', background: 'light' })
    expect(document.body.dataset.wdlBg).toBe('light')
    expect(light.getAttribute('aria-checked')).toBe('true')
  })
})

describe('parse error banner', () => {
  it('shows the banner and truncates to the five most recent errors', async () => {
    await bootWebview()
    ;(document.querySelector('[data-testid="emit-error"]') as HTMLButtonElement).click()
    await nextTick()

    const text = document.querySelector('.wdl-parse-errors')?.textContent ?? ''
    expect(text).toContain('Parse warnings (6)')
    expect(text).toContain('…and 1 more')
    expect(document.querySelectorAll('.wdl-parse-errors li')).toHaveLength(5)
  })
})

describe('node selection', () => {
  it('sends a plain nodeSelect with goToDefinition false when no modifier is held', async () => {
    const postMessage = await bootWebview()
    dispatchPointer('pointerdown', false)
    ;(document.querySelector('[data-testid="emit-node"]') as HTMLButtonElement).click()

    expect(postMessage).toHaveBeenCalledWith({
      type: 'nodeSelect',
      node: { id: 'call_align', kind: 'call', label: 'call align', taskName: 'align' },
      goToDefinition: false,
    })
  })

  it('sets goToDefinition true when ctrl is held at pointerdown', async () => {
    const postMessage = await bootWebview()
    dispatchPointer('pointerdown', true)
    ;(document.querySelector('[data-testid="emit-node"]') as HTMLButtonElement).click()

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'nodeSelect', goToDefinition: true })
    )
  })

  it('clears the modifier after pointercancel', async () => {
    const postMessage = await bootWebview()
    dispatchPointer('pointerdown', true)
    dispatchPointer('pointercancel')
    ;(document.querySelector('[data-testid="emit-node"]') as HTMLButtonElement).click()

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'nodeSelect', goToDefinition: false })
    )
  })
})