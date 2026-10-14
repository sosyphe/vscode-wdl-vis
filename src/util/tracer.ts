// In-situ tracing for the WDL language features.
//
// Why this exists: the go-to-definition path measures ~3.7 ms on a 113 KB
// document, yet over Remote-SSH a Ctrl+click can take 1-3 s. That gap cannot be
// explained from outside the process — either the call really is slow in the
// live host, or it is queued behind someone else on the shared, single-threaded
// extension host (Pylance and Jupyter are the usual suspects). This module
// answers which, with numbers instead of guesswork.
//
// Off by default (`wdl.viewer.trace`). When off, `span()` returns null and the
// Output Channel is never created — it is built lazily, on the first line
// actually written — so a normal session pays one boolean read and nothing else.
//
// The event-loop lag probe is the decisive signal: a stall it reports while our
// own phase timings stay small proves the *host* was blocked, not this
// extension. Conversely, small timings and no stalls mean the delay lives
// further out still (RPC, or the renderer).
//
// No `vscode` import here — the channel and the timer are injected, so this
// module is unit tested directly.

import type { Timer } from './debounce'
import { defaultTimer } from './debounce'

/** The slice of `vscode.OutputChannel` this module actually touches. */
export interface TraceChannel {
  appendLine(line: string): void
  /** Bring the channel on screen. Optional so a test stub need not fake it. */
  show?(): void
  dispose(): void
}

export interface TracerOptions {
  /** Read live on every call, so toggling the setting needs no reload. */
  enabled: () => boolean
  /** Invoked at most once — on the first line actually written. */
  createChannel: () => TraceChannel
  now?: () => number
  timer?: Timer
  /** A single traced call slower than this is flagged `SLOW`. */
  slowCallMs?: number
  /** Calls this close together are reported as one user gesture. */
  gestureWindowMs?: number
  /** Lag-probe poll interval, and the stall size worth reporting. */
  lagProbeMs?: number
  lagThresholdMs?: number
}

/**
 * One traced operation. `mark` closes the running phase and opens the next, so
 * a caller annotates its own stages without threading timestamps around.
 */
export interface TraceSpan {
  /** End the current phase, start timing `name`. */
  mark(name: string): void
  /** Finish, log, and fold into the running totals. */
  stop(detail?: string): void
}

/** Accumulated counters, exposed for `wdl.showDiagnostics` and for tests. */
export interface TraceStats {
  calls: number
  totalMs: number
  slowestMs: number
  slowCalls: number
  /** Distinct user gestures observed (calls grouped by proximity). */
  gestures: number
  /** Most provider invocations seen inside a single gesture. */
  maxCallsPerGesture: number
  /** Event-loop stalls reported by the lag probe. */
  lagStalls: number
  worstLagMs: number
  activationMs: number
}


export class Tracer {
  private readonly enabled: () => boolean
  private readonly createChannel: () => TraceChannel
  private readonly now: () => number
  private readonly timer: Timer
  private readonly slowCallMs: number
  private readonly gestureWindowMs: number
  private readonly lagProbeMs: number
  private readonly lagThresholdMs: number

  private channel: TraceChannel | null = null

  private stats: TraceStats = {
    calls: 0,
    totalMs: 0,
    slowestMs: 0,
    slowCalls: 0,
    gestures: 0,
    maxCallsPerGesture: 0,
    lagStalls: 0,
    worstLagMs: 0,
    activationMs: 0,
  }

  /** Current gesture: how many calls landed inside the window, and since when. */
  private gestureCalls = 0
  private gestureStart = -1

  private lagHandle: unknown = null
  private lagExpected = 0

  constructor(options: TracerOptions) {
    this.enabled = options.enabled
    this.createChannel = options.createChannel
    this.now = options.now ?? (() => Date.now())
    this.timer = options.timer ?? defaultTimer
    this.slowCallMs = options.slowCallMs ?? 50
    this.gestureWindowMs = options.gestureWindowMs ?? 500
    this.lagProbeMs = options.lagProbeMs ?? 500
    this.lagThresholdMs = options.lagThresholdMs ?? 250
  }

  get isEnabled(): boolean {
    return this.enabled()
  }

  /**
   * Begin tracing `label`.
   *
   * Timings and counters are accumulated *whether or not* tracing is enabled —
   * only the line write is gated. A handful of `Date.now()` calls is noise next
   * to the scan being measured, and it means `wdl.showDiagnostics` can report on
   * calls that happened before the user thought to flip the setting on.
   *
   * Convention: call `mark(name)` as each phase *begins*. The interval before
   * the first `mark` is unnamed and dropped from the breakdown; `stop` closes
   * the last phase marked.
   */
  span(label: string): TraceSpan {
    const startedAt = this.now()
    const phases: { name: string; ms: number }[] = []
    let phaseName = ''
    let phaseStart = startedAt
    let stopped = false

    this.beginGesture(startedAt)
    const callIndex = this.gestureCalls

    const span: TraceSpan = {
      mark: (name: string) => {
        if (stopped) return
        const at = this.now()
        if (phaseName !== '') phases.push({ name: phaseName, ms: at - phaseStart })
        phaseName = name
        phaseStart = at
      },
      stop: (detail?: string) => {
        if (stopped) return
        stopped = true
        const at = this.now()
        if (phaseName !== '') phases.push({ name: phaseName, ms: at - phaseStart })

        const total = at - startedAt
        this.stats.calls++
        this.stats.totalMs += total
        if (total > this.stats.slowestMs) this.stats.slowestMs = total
        const slow = total >= this.slowCallMs
        if (slow) this.stats.slowCalls++

        if (!this.enabled()) return

        const breakdown = phases
          .filter((phase) => phase.ms > 0)
          .map((phase) => `${phase.name}=${phase.ms.toFixed(2)}ms`)
          .join(' ')

        this.write(
          `${slow ? 'SLOW ' : ''}${label} ${total.toFixed(2)}ms ` +
            `[gesture ${this.stats.gestures} call ${callIndex}] ` +
            `${breakdown}${detail ? ` — ${detail}` : ''}`
        )
      },
    }
    return span
  }

  /**
   * Group calls into gestures: VS Code invokes a definition provider several
   * times per Ctrl+click (link detection while the modifier is held, then the
   * click itself), and the count is what makes caching worth doing.
   */
  private beginGesture(at: number): void {
    if (this.gestureStart !== -1 && at - this.gestureStart <= this.gestureWindowMs) {
      this.gestureCalls++
    } else {
      this.gestureStart = at
      this.gestureCalls = 1
      this.stats.gestures++
    }
    if (this.gestureCalls > this.stats.maxCallsPerGesture) {
      this.stats.maxCallsPerGesture = this.gestureCalls
    }
  }

  /** A one-off line: activation, a skipped webview post, a cache summary. */
  note(line: string): void {
    if (!this.enabled()) return
    this.write(line)
  }

  /** Record how long `activate()` took; logged on the first traced call. */
  setActivationMs(ms: number): void {
    this.stats.activationMs = ms
  }

  get snapshot(): TraceStats {
    return { ...this.stats }
  }

  /** Human-readable dump for `wdl.showDiagnostics`. */
  summary(extra: string[] = []): string[] {
    const s = this.stats
    const avg = s.calls > 0 ? s.totalMs / s.calls : 0
    return [
      `activation:      ${s.activationMs.toFixed(2)} ms`,
      `provider calls:  ${s.calls} in ${s.gestures} gesture(s) ` +
        `(max ${s.maxCallsPerGesture} per gesture)`,
      `call time:       avg ${avg.toFixed(2)} ms, slowest ${s.slowestMs.toFixed(2)} ms, ` +
        `${s.slowCalls} over ${this.slowCallMs} ms`,
      `event-loop lag:  ${s.lagStalls} stall(s) over ${this.lagThresholdMs} ms, ` +
        `worst ${s.worstLagMs.toFixed(0)} ms`,
      ...extra,
      '',
      'Reading this: small call times *plus* lag stalls mean the shared extension',
      'host was blocked by another extension, not by WDL Viewer. Small call times',
      'and *no* stalls point further out — the Remote-SSH RPC round trip or the',
      'renderer. Large call times mean the scan itself; check the phase breakdown.',
    ]
  }

  /**
   * Arm or disarm the lag probe to match the setting. Called on activation and
   * again on every configuration change, so tracing can be turned on mid-session.
   *
   * The probe is deliberately *not* left running while tracing is off: a
   * perpetual 500 ms timer would keep the host from ever going idle.
   */
  refresh(): void {
    if (this.enabled()) this.armLagProbe()
    else this.disarmLagProbe()
  }

  private armLagProbe(): void {
    if (this.lagHandle !== null) return
    this.lagExpected = this.now() + this.lagProbeMs
    this.scheduleLagProbe()
  }

  private disarmLagProbe(): void {
    if (this.lagHandle === null) return
    this.timer.clearTimeout(this.lagHandle)
    this.lagHandle = null
  }

  private scheduleLagProbe(): void {
    this.lagHandle = this.timer.setTimeout(() => {
      this.lagHandle = null
      const at = this.now()
      // Drift past the expected wake-up is time the loop spent elsewhere.
      const lag = at - this.lagExpected
      if (lag > this.lagThresholdMs) {
        this.stats.lagStalls++
        if (lag > this.stats.worstLagMs) this.stats.worstLagMs = lag
        this.write(`EVENT LOOP STALLED ${lag.toFixed(0)}ms (probe overrun)`)
      }
      if (!this.enabled()) return // disarmed while we were mid-flight
      this.lagExpected = at + this.lagProbeMs
      this.scheduleLagProbe()
    }, this.lagProbeMs)
  }

  /**
   * Write the summary and reveal the channel. Backs `wdl.showDiagnostics`.
   *
   * Deliberately ignores `enabled`: the user asked for this explicitly, and
   * refusing to answer because a trace setting is off would be unhelpful. The
   * counters are accumulated whether or not lines were being logged.
   */
  showSummary(extra: string[] = []): void {
    for (const line of this.summary(extra)) this.write(line)
    this.channel?.show?.()
  }

  private write(line: string): void {
    if (this.channel === null) this.channel = this.createChannel()
    this.channel.appendLine(line)
  }

  dispose(): void {
    this.disarmLagProbe()
    this.channel?.dispose()
    this.channel = null
  }
}

/**
 * The tracer used when none is injected — every call is free.
 *
 * Providers default to this rather than to `null`, so their hot paths read
 * `this.tracer.span(...)` unconditionally instead of branching on a nullable
 * field at every step.
 */
export const nullTracer: Tracer = new Tracer({
  enabled: () => false,
  createChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
})
