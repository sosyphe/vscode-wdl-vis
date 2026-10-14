// Graph webview entry point. Bundled to dist/webview.js (ESM) and loaded with
// `<script type="module">` — see scripts/build.mjs for why ESM is mandatory.
//
// The Vue app is created exactly once. Document edits arrive as `update`
// messages that only reassign a ref; WdlViewer's internal
// `computed(() => parseWdl(props.wdlText))` re-runs and the graph re-lays out in
// place, so zoom/pan state and scroll position survive keystrokes.

import { createApp, defineComponent, h, ref } from 'vue'
import { WdlViewer } from 'wdl-viewer'
import type { WdlNode } from 'wdl-viewer/parser'
import 'wdl-viewer/style.css'

import { isHostMessage, pickNode } from '../protocol'
import type { Background } from '../protocol'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

// Ctrl/Cmd+click detection. WdlViewer's `nodeSelect` emit carries no DOM event,
// so the modifier state is sniffed here instead: window-level *capture* listeners
// always run before Vue's own bubble-phase pointer handlers, and `nodeSelect`
// fires synchronously inside the same `pointerup` dispatch — so the flag read
// below always belongs to the current gesture. `pointercancel` clears it (the
// graph treats a cancelled pointer like a click in some paths).
let lastPointerHadModifier = false
function recordPointerModifiers(event: PointerEvent): void {
  lastPointerHadModifier = event.ctrlKey || event.metaKey
}
window.addEventListener('pointerdown', recordPointerModifiers, true)
window.addEventListener('pointerup', recordPointerModifiers, true)
window.addEventListener(
  'pointercancel',
  () => {
    lastPointerHadModifier = false
  },
  true
)

const text = ref('')
const fileName = ref('')
const parseErrors = ref<string[]>([])
const background = ref<Background>('auto')

/**
 * Apply a background mode locally: theme.css keys its palettes off this
 * attribute, and the status-bar switch highlights the active button off the
 * same ref.
 */
function applyBackground(mode: Background): void {
  background.value = mode
  document.body.dataset.wdlBg = mode
}

/** Ask the host to persist the mode; the echo arrives as the next update. */
function selectBackground(mode: Background): void {
  applyBackground(mode) // immediate feedback, confirmed (or corrected) by the host echo
  vscode.postMessage({ type: 'backgroundSelect', background: mode })
}

const BACKGROUND_OPTIONS: readonly { value: Background; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Follow the VS Code color theme' },
  { value: 'light', label: 'Light', title: 'Always use a light background' },
  { value: 'dark', label: 'Dark', title: 'Always use a dark background' },
]

const MAX_VISIBLE_ERRORS = 5

const errorBanner = defineComponent({
  name: 'WdlErrorBanner',
  setup() {
    return () => {
      const errors = parseErrors.value
      if (errors.length === 0) return null

      const shown = errors.slice(0, MAX_VISIBLE_ERRORS)
      const hidden = errors.length - shown.length

      return h('div', { class: 'wdl-parse-errors', role: 'status' }, [
        h('div', { class: 'wdl-parse-errors__title' }, `Parse warnings (${errors.length})`),
        h(
          'ul',
          { class: 'wdl-parse-errors__list' },
          shown.map((message, index) =>
            h('li', { class: 'wdl-parse-errors__item', key: index }, message)
          )
        ),
        hidden > 0
          ? h('div', { class: 'wdl-parse-errors__more' }, `…and ${hidden} more`)
          : null,
      ])
    }
  },
})

const Root = defineComponent({
  name: 'WdlGraphWebview',
  setup() {
    return () =>
      h('div', { class: 'wdl-webview-root' }, [
        h(errorBanner),
        h('div', { class: 'wdl-webview-graph' }, [
          h(WdlViewer, {
            wdlText: text.value,
            width: '100%',
            height: '100%',
            onNodeSelect: (node: WdlNode | null) => {
              vscode.postMessage({
                type: 'nodeSelect',
                node: node ? pickNode(node) : null,
                // Ctrl/Cmd+click asks the host for the task definition instead
                // of the call statement.
                goToDefinition: node !== null && lastPointerHadModifier,
              })
            },
            // WdlViewer only emits when there *are* errors, so the banner is
            // cleared on every host update instead of relying on an empty emit.
            onParseError: (errors: string[]) => {
              parseErrors.value = errors
            },
          }),
        ]),
        h('div', { class: 'wdl-webview-status' }, [
          h('span', { class: 'wdl-webview-status__name' }, fileName.value),
          h(
            'div',
            { class: 'wdl-bg-switch', role: 'radiogroup', 'aria-label': 'Graph background' },
            BACKGROUND_OPTIONS.map((option) =>
              h(
                'button',
                {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': background.value === option.value ? 'true' : 'false',
                  class: background.value === option.value ? 'wdl-bg-switch__btn active' : 'wdl-bg-switch__btn',
                  title: option.title,
                  onClick: () => selectBackground(option.value),
                },
                option.label
              )
            )
          ),
        ]),
      ])
  },
})

createApp(Root).mount('#app')

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data
  if (!isHostMessage(message)) return

  // Both branches carry the same payload; `init` is just the first `update`.
  text.value = message.text
  fileName.value = message.fileName
  parseErrors.value = []
  // The host is the source of truth for the background mode: this confirms a
  // local `selectBackground` click and picks up changes made in the Settings UI.
  applyBackground(message.background)
})

vscode.postMessage({ type: 'ready' })
