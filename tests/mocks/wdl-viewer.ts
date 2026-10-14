// Stub of `wdl-viewer` for the webview unit test. `src/graph/webview/main.ts` renders
// the real component via `h(WdlViewer, { wdlText, onNodeSelect, onParseError })`;
// here it only exists to expose two buttons that emit `nodeSelect` / `parseError`,
// so the host-message wiring in main.ts can be exercised without the real
// parser / DAG / dagre.
//
// Aliased in vitest.config.ts (like the `vscode` mock) because the real package
// is `file:`-linked and not built during this repo's tests.

import { defineComponent, h } from 'vue'

export const FAKE_NODE = {
  id: 'call_align',
  kind: 'call',
  label: 'call align',
  taskName: 'align',
}

export const FAKE_ERRORS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']

export const WdlViewer = defineComponent({
  name: 'WdlViewer',
  emits: ['nodeSelect', 'parseError'],
  setup(_props, { emit }) {
    return () =>
      h('div', { class: 'wdl-viewer-stub' }, [
        h(
          'button',
          {
            type: 'button',
            'data-testid': 'emit-node',
            onClick: () => emit('nodeSelect', FAKE_NODE),
          },
          'emit node'
        ),
        h(
          'button',
          {
            type: 'button',
            'data-testid': 'emit-error',
            onClick: () => emit('parseError', FAKE_ERRORS),
          },
          'emit error'
        ),
      ])
  },
})