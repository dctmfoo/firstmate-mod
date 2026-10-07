// Quiet rail: the Firstmate band above the prompt and the /fm-fleet pane.
//
// Reads happen on lifecycle-managed timers outside every drawing, each lane
// on its own cadence and never overlapping itself; drawings only read the
// cached lanes from $.state. The mod writes nothing outside its own session
// state, and offers no approve, merge, dispatch or steer action.

import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, TextProps, Timer } from 'claude-code'

import type { CrewRecords, Lane, QuotaRecords } from '../types'
import { bandLines, statusText } from './band'
import { configOf } from './config'
import { discussDraft } from './discuss'
import { fleetViewOf, type FleetView } from './fleet'
import { paneItems, type PaneItem } from './pane'
import { type Host, newCrewCache, readCrew, readHome, readQuota } from './sources'
import type { Line, Tone } from './text'
import { EMPTY_LEDGER, type ToastKind, transitions } from './toasts'

export const PANE_ID = 'firstmate-fleet'
export const PANE_TITLE = 'Firstmate'

/**
 * The docked width the pane asks for: room for a full forge URL, narrow enough
 * that the conversation keeps most of the screen. A width the person drags wins.
 */
const DOCK_COLUMNS = 72

/** The band's own way into the pane, beside its first row. */
const OPEN_LABEL = '  /fm-fleet'

/** How long after a /clear's session.end the lanes are read again. */
const CLEAR_SETTLE_MS = 500

const homeLane = atom({ plugin: 'firstmate-mod', key: 'home' } as const, { value: null, readAt: null, error: null })
const crewLane = atom({ plugin: 'firstmate-mod', key: 'crew' } as const, { value: null, readAt: null, error: null })
const quotaLane = atom({ plugin: 'firstmate-mod', key: 'quota' } as const, { value: null, readAt: null, error: null })
const toastLedger = atom({ plugin: 'firstmate-mod', key: 'ledger' } as const, EMPTY_LEDGER)

const FLEET_COMMAND = {
  name: 'fm-fleet',
  description: 'Open the Firstmate pane: what needs you, and every worker by state (read-only)',
}

const REFRESH_COMMAND = {
  name: 'fm-refresh',
  description: 'Re-read the configured Firstmate home now (read-only; runs no session start, reconcile or supervision)',
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function hostOf($: EngineInterface): Host {
  return {
    read: path => $.fs.read(path),
    list: path => $.fs.list(path),
    mtime: path => $.fs.stat(path).then(
      stat => (stat.kind === 'file' ? stat.mtimeMs : null),
      () => null,
    ),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
  }
}

async function lanesOf($: EngineInterface) {
  return {
    home: await read($, homeLane),
    crew: await read($, crewLane),
    quota: await read($, quotaLane),
  }
}

const COLORS: Record<Tone, { color?: string; bold?: boolean; dimColor?: boolean }> = {
  brand: { color: 'green', bold: true },
  head: { color: 'green' },
  plain: {},
  muted: { dimColor: true },
  warn: { color: 'yellow' },
}

/** What one load of the module keeps: its options, the in-flight guards, its timers. */
const runtime = {
  config: configOf({}),
  crewCache: newCrewCache(),
  inFlight: { home: false, crew: false, quota: false },
  timers: [] as Timer[],
  /** The status line as this load last set it; null until it has, so a reload sets it afresh. */
  shownStatus: null as string | undefined | null,
  /**
   * Starts a full re-read on the session's own engine handle (the one
   * session.start gave the timers), so the work outlives the command, press
   * or /clear dispatch that asked for it.
   */
  kick: null as ((delayMs?: number) => void) | null,
}

async function settle($: EngineInterface, kinds: ToastKind[]) {
  try {
    const now = await $.clock.now()
    const view = fleetViewOf(runtime.config.home, await lanesOf($), now)
    const status = statusText(view)
    if (status !== runtime.shownStatus) {
      runtime.shownStatus = status
      await $.ui.status(status)
    }
    // Most reads change nothing: skip the session-state write unless the ledger moved.
    const ledger = await read($, toastLedger)
    if (transitions(ledger, view, runtime.config.headroomToastPercent, kinds).ledger === ledger) return
    let toasts: string[] = []
    await update($, toastLedger, current => {
      const step = transitions(current, view, runtime.config.headroomToastPercent, kinds)
      toasts = step.toasts
      return step.ledger
    })
    for (const text of toasts) await $.ui.toast(text)
  } catch {
    // A status line or toast the host refused must not stop the lane's next read.
    runtime.shownStatus = null
  }
}

/** A lane after a failed read: its last good value kept beside the newest failure. */
const failure = <T,>(prev: Lane<T>, error: unknown, at: number): Lane<T> => ({
  ...prev,
  error: { reason: messageOf(error), at },
})

async function refreshHome($: EngineInterface) {
  const { config, inFlight } = runtime
  if (config.home === null || inFlight.home) return
  inFlight.home = true
  try {
    const value = await readHome(hostOf($), config.home, runtime.crewCache.backlog)
    const at = await $.clock.now()
    await update($, homeLane, () => ({ value, readAt: at, error: null }))
  } catch (error) {
    const at = await $.clock.now()
    await update($, homeLane, prev => failure(prev, error, at))
  } finally {
    inFlight.home = false
  }
  await settle($, ['needs', 'landed'])
}

async function refreshCrew($: EngineInterface) {
  const { config, inFlight } = runtime
  if (config.home === null || inFlight.crew) return
  inFlight.crew = true
  try {
    const prev = (await read($, crewLane)).value
    const at = await $.clock.now()
    const value: CrewRecords = await readCrew(hostOf($), config.home, config.herdrCommand, runtime.crewCache, prev, at)
    await update($, crewLane, () => ({ value, readAt: at, error: null }))
  } catch (error) {
    const at = await $.clock.now()
    await update($, crewLane, prev => failure(prev, error, at))
  } finally {
    inFlight.crew = false
  }
  await settle($, ['stuck'])
}

async function refreshQuota($: EngineInterface) {
  const { config, inFlight } = runtime
  if (config.home === null || inFlight.quota) return
  inFlight.quota = true
  try {
    const value: QuotaRecords = await readQuota(hostOf($), config.quotaCommand, config.home)
    const at = await $.clock.now()
    await update($, quotaLane, () => ({ value, readAt: at, error: null }))
  } catch (error) {
    const at = await $.clock.now()
    await update($, quotaLane, prev => failure(prev, error, at))
  } finally {
    inFlight.quota = false
  }
  await settle($, ['headroom'])
}

async function refreshAll($: EngineInterface) {
  await Promise.all([refreshHome($), refreshCrew($), refreshQuota($)])
}

function startTimers($: EngineInterface) {
  for (const timer of runtime.timers) timer.cancel()
  const { config } = runtime
  if (config.home === null) {
    runtime.timers = []
    return
  }
  runtime.kick = (delayMs = 0) => {
    $.clock.after(delayMs, () => void refreshAll($))
  }
  runtime.timers = [
    $.clock.after(0, () => void refreshAll($)),
    $.clock.every(config.herdrMs, () => void refreshCrew($)),
    $.clock.every(config.summaryMs, () => void refreshHome($)),
    $.clock.every(config.headroomMs, () => void refreshQuota($)),
  ]
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true, columns: DOCK_COLUMNS })
}

function lineOf(Text: ElementConstructor<TextProps>, line: Line) {
  return <Text>{line.map(s => <Text {...COLORS[s.tone]}>{s.text}</Text>)}</Text>
}

export const register: Register = (on, options) => {
  runtime.config = configOf(options)
  const { config } = runtime

  on('session.start', async ($, e, next) => {
    await $.command.register({ ...FLEET_COMMAND, immediate: true })
    await $.command.register({ ...REFRESH_COMMAND, immediate: true })
    startTimers($)
    return next(e)
  })

  // A /clear ends the conversation and resets the session's $.state, with no
  // session.start after it: read again once the reset has landed, rather than
  // waiting a full cadence, and let the toast ledger baseline afresh.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') runtime.kick?.(CLEAR_SETTLE_MS)
    return next(e)
  })

  on('command.run', { command: FLEET_COMMAND.name }, async $ => {
    const opened = await openPane($)
    const where = opened.isPlaced ? '' : ` (waiting: ${opened.reason})`
    return { text: `Firstmate pane opened, read-only${where}.` }
  })

  on('command.run', { command: REFRESH_COMMAND.name }, async $ => {
    if (config.home === null) return { text: 'Firstmate: no home configured; nothing to read.' }
    runtime.kick?.()
    return { text: `Firstmate: re-reading ${config.home} (read-only).` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const view: FleetView = fleetViewOf(config.home, await lanesOf($), now)
    const width = Math.max(20, e.props.bodyColumns)
    // The first row keeps room for the button, so a link or a name is never truncated to fit it.
    const lines = bandLines(view, width - OPEN_LABEL.length - 1, width, now)
    const below = await next(e)
    // The rule is the band's first row to go when the slot is short (an inline pane open).
    const hasRule = e.props.maxRows > lines.length
    return (
      <Box flexDirection="column">
        {hasRule && (
          <Text color="green" dimColor>
            {'─'.repeat(width)}
          </Text>
        )}
        {lines.map((l, i) =>
          i === 0 ? (
            <Box flexDirection="row" flexWrap="wrap">
              {lineOf(Text, l)}
              <Button key="open-fleet" label={OPEN_LABEL} plain dimColor onPress={() => openPane($)} />
            </Box>
          ) : (
            lineOf(Text, l)
          ),
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const view = fleetViewOf(config.home, await lanesOf($), now)
    const width = Math.max(24, e.props.bodyColumns)
    const items = paneItems(view, width, now)
    const itemOf = (item: PaneItem) => {
      switch (item.kind) {
        case 'line':
          return item.indent === undefined ? lineOf(Text, item.line) : <Box paddingLeft={item.indent}>{lineOf(Text, item.line)}</Box>
        case 'gap':
          return <Text> </Text>
        case 'header':
          return (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Text {...COLORS.brand}>FIRSTMATE</Text>
              <Button key="refresh" label="refresh" hotkey="r" plain dimColor onPress={() => runtime.kick?.()} />
              <Text dimColor>Esc closes</Text>
            </Box>
          )
        case 'discuss':
          return (
            <Box flexDirection="row" paddingLeft={2}>
              <Button
                key={`discuss-${item.call.key}`}
                label="Discuss with Firstmate"
                onPress={() => $.prompt.fill({ text: discussDraft(item.call), mode: 'insert' })}
              />
            </Box>
          )
      }
    }
    return <Box flexDirection="column">{items.map(itemOf)}</Box>
  })
}
