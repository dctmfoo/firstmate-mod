// Commands, timers, the read-only boundary, toasts, and what survives /clear
// and a reload.

import { describe, expect, test } from 'claude-code/testing'

import { DEMO_HOME } from './fixtures/demo-home'
import { agentList, captureEpoch, HOME, inReplay, SESSION, started, summaryEdit, withFiles } from './fixtures/replay'

// Advancing the engine's timers can exceed five seconds on a busy host.
const OPTIONS = { timeoutMs: 30_000, options: { home: HOME } }

const BAND = {
  plugin: 'firstmate-mod',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 255, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const PANE = {
  plugin: 'firstmate-mod',
  component: 'Pane',
  requestId: 'firstmate-fleet',
  viewport: { columns: 180, rows: 50, isFullscreen: true },
  props: { title: 'Firstmate', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HARBOR = 'w44:t3H'
const OFFLINE = 'w44:t3N'
const SEARCH = 'w44:t3B'
const UPLOAD = 'w44:t3F'
const SDK = 'w44:t3D'
const CAPTURED = { [SEARCH]: 'done', [SDK]: 'done', [UPLOAD]: 'done', [HARBOR]: 'done', [OFFLINE]: 'working' } as Record<string, string>

const HERDR_MS = 5_000
const SUMMARY_MS = 30_000
const HEADROOM_MS = 900_000

const FLEET = { command: 'fm-fleet', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never
const REFRESH = { command: 'fm-refresh', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never

const countRuns = (world: { runs: { argv: readonly string[] }[] }, command: string) =>
  world.runs.filter(run => run.argv[0] === command).length

const crewText = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^(Stuck|Just finished|Working|Waiting|No workers|can't read Herdr|\+\d+ more)/.test(t))

describe('commands', () => {
  test('the session start registers /fm-fleet and /fm-refresh only, each runnable mid-turn', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    expect(world.commands).toEqual(['fm-fleet', 'fm-refresh'])
  })

  test('/fm-fleet opens the pane focused and Esc-closable', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const answer = await $.command.run(FLEET)
    expect(answer.text).toBe('Firstmate pane opened, read-only.')
    expect(world.opened.at(-1)).toMatchObject({ id: 'firstmate-fleet', focus: true, closeOnEscape: true })
    expect(world.opened.at(-1)?.holdToasts).toBeUndefined()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'NEEDS YOU (5)' })).toBeDefined()
  })

  test('the band button opens the pane too', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'open-fleet' })
    expect(world.opened).toHaveLength(1)
  })

  test('/fm-refresh re-reads everything at once', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const before = countRuns(world, 'herdr')
    const reads = world.reads.filter(path => path === 'state/home-summary.json').length
    await $.command.run(REFRESH)
    await world.clock.advance(1)
    expect(countRuns(world, 'herdr') - before).toBe(1)
    expect(world.reads.filter(path => path === 'state/home-summary.json').length - reads).toBe(1)
  })
})

describe('read-only boundary', () => {
  test('every read is a file read, a listing, a stat, `herdr agent list` or quota-axi; nothing is written', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(HEADROOM_MS)
    const commands = new Set(world.runs.map(run => run.argv[0]))
    expect([...commands].sort()).toEqual(['herdr', 'quota-axi'])
    for (const run of world.runs) {
      if (run.argv[0] === 'quota-axi') expect(run.argv.slice(1)).toEqual(['--provider', 'claude,codex', '--json', '--no-credential-refresh'])
      else expect(run.argv).toEqual(['herdr', 'agent', 'list'])
    }
    expect(world.writes).toEqual([])
  })

  test('reads no screen, no worker-state helper and no contribution file', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(HEADROOM_MS)
    for (const path of world.reads) expect(path).toMatch(/^(state\/home-summary\.json|state\/[A-Za-z0-9._-]+\.(meta|status)|data\/backlog\.md)$/)
    expect(world.runs.some(run => run.argv.some(arg => /fm-crew-state|read|screen|scrollback/.test(arg)))).toBe(false)
    expect(world.lists.every(path => path === 'state')).toBe(true)
  })

  test('lanes keep their own cadence: Herdr 5 s, summary 30 s, quota 15 min', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const summaries = () => world.reads.filter(path => path === 'state/home-summary.json').length
    expect([countRuns(world, 'herdr'), summaries(), countRuns(world, 'quota-axi')]).toEqual([1, 1, 1])
    await world.clock.advance(HERDR_MS)
    expect([countRuns(world, 'herdr'), summaries(), countRuns(world, 'quota-axi')]).toEqual([2, 1, 1])
    await world.clock.advance(SUMMARY_MS - HERDR_MS)
    expect([countRuns(world, 'herdr'), summaries(), countRuns(world, 'quota-axi')]).toEqual([7, 2, 1])
    await world.clock.advance(HEADROOM_MS - SUMMARY_MS)
    expect(countRuns(world, 'quota-axi')).toBe(2)
  })

  test('each file is read again only when it changed: metadata once, statuses on mtime, the backlog once', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(60_000)
    const count = (path: string) => world.reads.filter(read => read === path).length
    expect(count('data/backlog.md')).toBe(1)
    expect(count('state/lighthouse-offline-map-b1.meta')).toBe(1)
    expect(count('state/tidepool-upload-retry-c1.status')).toBe(1)
    const epoch = captureEpoch(DEMO_HOME)
    world.files = withFiles(DEMO_HOME, { 'state/tidepool-upload-retry-c1.status': `${DEMO_HOME.files['state/tidepool-upload-retry-c1.status']}working [at=${epoch + 70}]: resumed\n` })
    await world.clock.advance(HERDR_MS)
    expect(count('state/tidepool-upload-retry-c1.status')).toBe(2)
    expect(count('state/lighthouse-sdk-pin-f1.status')).toBe(1)
    await world.clock.advance(60_000)
    expect(count('state/tidepool-upload-retry-c1.status')).toBe(2)
  })

  test('a new task is read once, and the backlog again only then', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    world.files = withFiles(DEMO_HOME, {
      'state/newtask-s1.meta': 'project=firstmate-mod\nharness=codex\nkind=scout\nherdr_tab_id=w44:t99\n',
      'data/backlog.md': `${DEMO_HOME.files['data/backlog.md']}- [ ] newtask-s1 - firstmate-mod: look into a thing (repo: firstmate-mod) (kind: scout)\n`,
      'herdr/agent-list.json': agentList({ ...CAPTURED, 'w44:t99': 'working' }),
    })
    await world.clock.advance(HERDR_MS)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await crewText(ui)).toContain('look into a thing <1m')
    expect(world.reads.filter(path => path === 'data/backlog.md')).toHaveLength(2)
  })

  test('a worker the backlog does not list is named by its task id', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: withFiles(DEMO_HOME, { 'data/backlog.md': '' }) })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await crewText(ui)).toContain('lighthouse-offline-map-b1')
  })
})

describe('read cost', () => {
  test('a crew read stats no task file: the one state listing carries every mtime', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(60_000)
    expect(world.stats.filter(path => path.startsWith('state/'))).toEqual([])
    // Twelve crew reads and three summary reads list state/ once each.
    expect(world.lists.length).toBeLessThanOrEqual(13 + 3)
  })

  test('metadata rewritten for a relaunch is read again, so the worker follows its new tab', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const meta = 'state/lighthouse-offline-map-b1.meta'
    const tabs = { ...CAPTURED }
    delete tabs[OFFLINE]
    world.files = withFiles(DEMO_HOME, {
      [meta]: DEMO_HOME.files[meta]!.replace(OFFLINE, 'w44:t9Z'),
      'herdr/agent-list.json': agentList({ ...tabs, 'w44:t9Z': 'working' }),
    })
    await world.clock.advance(HERDR_MS)
    const crew = await crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))
    expect(crew).toContain('Working  add the offline map')
    expect(crew).not.toContain('window closed')
    expect(world.reads.filter(path => path === meta)).toHaveLength(2)
  })

  test('a worker named by its task id gets its title once the backlog lists it', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: withFiles(DEMO_HOME, { 'data/backlog.md': '' }) })
    await started($, world)
    expect(await crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toContain('lighthouse-offline-map-b1')
    world.files = { ...DEMO_HOME.files }
    await world.clock.advance(HERDR_MS)
    expect(await crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toContain('Working  add the offline map')
  })
})

describe('time in state', () => {
  test('the mod stamps a change when its read sees it, and keeps the stamp while the state holds', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(3 * 60_000)
    const band = async () => crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))
    expect(await band()).toContain('Working  add the offline map 3m')
    // The pane stops: its time now counts from the read that saw it, not from the first sighting.
    world.files = withFiles(DEMO_HOME, { 'herdr/agent-list.json': agentList({ ...CAPTURED, [OFFLINE]: 'done' }) })
    await world.clock.advance(HERDR_MS)
    expect(await band()).toContain('Working  add the offline map <1m')
    await world.clock.advance(2 * 60_000)
    expect(await band()).toContain('Working  add the offline map 2m')
  })
})

describe('first sighting', () => {
  test('a worker with no status line yet is timed from when it was spawned', OPTIONS, async ($, on) => {
    const spawned = captureEpoch(DEMO_HOME) - 7 * 60
    const world = inReplay(on, {
      ...DEMO_HOME,
      files: withFiles(DEMO_HOME, { 'state/lighthouse-offline-map-b1.meta': `${DEMO_HOME.files['state/lighthouse-offline-map-b1.meta']}spawn_gen=s${spawned}.6818.17640\n` }),
    })
    await started($, world)
    expect(await crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toContain('Working  add the offline map 7m')
  })
})

describe('failures', () => {
  test('an unreadable summary is said once on the status line; the last good view stays', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    world.files = { ...world.files, 'state/home-summary.json': '{ torn' }
    await world.clock.advance(SUMMARY_MS)
    await world.clock.advance(SUMMARY_MS)
    expect(world.statuses.filter(s => s !== undefined)).toEqual(['Firstmate summary read failed: state/home-summary.json is not JSON'])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /4 more need you/ })).toBeDefined()
    world.files = { ...DEMO_HOME.files }
    await world.clock.advance(SUMMARY_MS)
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('a Herdr read that fails keeps the last good crew beside the failure, and recovers', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const original = world.files['herdr/agent-list.json']
    world.files = { ...world.files, 'herdr/agent-list.json': 'not json' }
    await world.clock.advance(HERDR_MS)
    expect(world.statuses.at(-1)).toMatch(/^Herdr read failed: herdr agent list output unreadable/)
    expect(await crewText(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toMatch(/^Just finished/)
    world.files = { ...world.files, 'herdr/agent-list.json': original! }
    await world.clock.advance(HERDR_MS)
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('a quota read that fails changes nothing the band shows', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME, { quotaFails: 'quota-axi: no credentials' })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await crewText(ui)).toMatch(/^Just finished/)
    expect(world.statuses.filter(s => s !== undefined)).toEqual([])
  })
})

describe('toasts', () => {
  test('history never toasts: the first read is a silent baseline', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(HEADROOM_MS)
    expect(world.toasts).toEqual([])
  })

  test('a new call, a new merge ask and a new landing toast once each', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    world.files = withFiles(DEMO_HOME, {
      ...summaryEdit(DEMO_HOME, doc => {
        ;(doc.decisions_open as unknown[]).push({ id: 'new-call-s1', key: 'new-call-s1', verb: 'captain-hold', summary: 'Pick the v2 scope', hold_bucket: 'live', hold_age_days: 0 })
        ;(doc.contributions as { captain: unknown[] }).captain.push({ task: 'newtask-s1', url: 'https://github.com/dctmfoo/firstmate-mod/pull/2' })
        ;(doc.landed as unknown[]).unshift({ id: 'new-ship-b1', title: 'Ship the thing', kind: 'ship', pr_url: 'https://github.com/dctmfoo/firstmate-mod/pull/1', completion: { verb: 'merged', date: '2026-10-04' } })
      }),
      // The new merge ask's task is open in the backlog, so it still waits on the captain.
      'data/backlog.md': `${DEMO_HOME.files['data/backlog.md']}- [ ] newtask-s1 - firstmate-mod: ship a thing (repo: firstmate-mod) (kind: ship)\n`,
    })
    await world.clock.advance(SUMMARY_MS)
    await world.clock.advance(SUMMARY_MS)
    expect(world.toasts).toEqual([
      'Firstmate: merge? newtask-s1 https://github.com/dctmfoo/firstmate-mod/pull/2',
      'Firstmate: needs you: Pick the v2 scope',
      'Firstmate: merged: Ship the thing https://github.com/dctmfoo/firstmate-mod/pull/1',
    ])
  })

  test('a worker that gets stuck toasts once, and again only after it got unstuck', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const blocked = withFiles(DEMO_HOME, { 'herdr/agent-list.json': agentList({ ...CAPTURED, [SDK]: 'blocked' }) })
    world.files = blocked
    await world.clock.advance(HERDR_MS)
    await world.clock.advance(HERDR_MS)
    expect(world.toasts).toEqual(['Firstmate: the release build pins an old… is stuck: question on its screen'])
    world.files = { ...DEMO_HOME.files }
    await world.clock.advance(HERDR_MS)
    world.files = blocked
    await world.clock.advance(HERDR_MS)
    expect(world.toasts).toHaveLength(2)
  })

  test('a provider entering the headroom threshold toasts once', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const quota = JSON.parse(DEMO_HOME.files['quota.json']!) as { providers: { quotaSemantics: { effectiveAvailability: { effectivePercentRemaining: number }[] } }[] }
    quota.providers[1]!.quotaSemantics.effectiveAvailability[0]!.effectivePercentRemaining = 7
    world.files = { ...world.files, 'quota.json': JSON.stringify(quota) }
    await world.clock.advance(HEADROOM_MS)
    await world.clock.advance(HEADROOM_MS)
    expect(world.toasts).toEqual(['Firstmate: Codex headroom 7% (week window)'])
  })
})

describe('host refusals', () => {
  test('a toast the host refuses does not stop the next reads', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME, { toastFails: 'toasts are off' })
    await started($, world)
    world.files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.decisions_open as unknown[]).push({ id: 'new-call-s1', key: 'new-call-s1', verb: 'captain-hold', summary: 'Pick the v2 scope', hold_bucket: 'live' })
    }))
    await world.clock.advance(SUMMARY_MS)
    const summaries = world.reads.filter(path => path === 'state/home-summary.json').length
    await world.clock.advance(SUMMARY_MS)
    expect(world.reads.filter(path => path === 'state/home-summary.json').length).toBe(summaries + 1)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /5 more need you/ })).toBeDefined()
  })
})

describe('session lifetimes', () => {
  test("after /clear every lane reads again at once, on the session's own timers", OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const before = world.runs.length
    // /clear ends the conversation; the session's $.state resets to its defaults.
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    await world.clock.advance(500)
    expect(world.runs.length - before).toBe(1 + 1)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await crewText(ui)).toMatch(/^Just finished/)
    expect(world.toasts).toEqual([])
  })

  test('a reload draws from the kept session state at once and toasts nothing again', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    world.files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.decisions_open as unknown[]).push({ id: 'new-call-s1', key: 'new-call-s1', verb: 'captain-hold', summary: 'Pick the v2 scope', hold_bucket: 'live' })
    }))
    await world.clock.advance(SUMMARY_MS)
    expect(world.toasts).toHaveLength(1)
    // A reload runs session.start again over the kept $.state.
    const runsBefore = world.runs.length
    await $.session.start(SESSION)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(world.runs.length).toBe(runsBefore)
    expect(await ui.find({ type: 'Text', text: /5 more need you/ })).toBeDefined()
    await world.clock.advance(SUMMARY_MS)
    expect(world.toasts).toHaveLength(1)
    // The restarted timers replaced the old ones rather than doubling them.
    const herdrBefore = countRuns(world, 'herdr')
    await world.clock.advance(HERDR_MS)
    expect(countRuns(world, 'herdr') - herdrBefore).toBe(1)
  })

  test('a resume restores the band and pane from the kept lanes, reads again on its own start, and replays no toast', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    world.files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.decisions_open as unknown[]).push({ id: 'new-call-s1', key: 'new-call-s1', verb: 'captain-hold', summary: 'Pick the v2 scope', hold_bucket: 'live' })
    }))
    await world.clock.advance(SUMMARY_MS)
    expect(world.toasts).toHaveLength(1)
    // claude --resume / --continue: the old session ends with 'resume', then the resumed one starts.
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
    await $.session.start(SESSION)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /5 more need you/ })).toBeDefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: 'NEEDS YOU (6)' })).toBeDefined()
    await pane.unmount()
    await band.unmount()
    // Its own start reads every lane once, and nothing already announced toasts again.
    const before = world.runs.length
    await world.clock.advance(500)
    expect(world.runs.length - before).toBe(1 + 1)
    await world.clock.advance(SUMMARY_MS)
    expect(world.toasts).toHaveLength(1)
  })

  test('a worker keeps its time in state across a reload', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(4 * 60_000)
    await $.session.start(SESSION)
    await world.clock.advance(1)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await crewText(ui)).toContain('Working  add the offline map 4m')
  })
})
