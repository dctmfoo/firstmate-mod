import { describe, expect, test } from 'claude-code/testing'

import { DEMO_HOME } from './fixtures/demo-home'
import { agentList, captureEpoch, HOME, inReplay, started, summaryEdit, withFiles } from './fixtures/replay'

const OPTIONS = { options: { home: HOME } }
// Reads once a minute, for the tests that let an hour go by.
const SLOW = { options: { home: HOME, herdr_seconds: 60 } }

const BAND = {
  plugin: 'firstmate-mod',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 155,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const textsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

/** The two band rows: the outer text that starts with the brand, and the crew row. */
async function rowsOf(ui: Parameters<typeof textsOf>[0]) {
  const texts = await textsOf(ui)
  return {
    first: texts.find(t => t.startsWith('FIRSTMATE') || t.startsWith('FM')),
    crew: texts.find(t => /^(Stuck|Just finished|Working|Waiting|No workers|reading Herdr|can't read Herdr|\+\d+ more)/.test(t)),
    all: texts,
  }
}

// The demo home's tabs: the Harbor backport (done, PR 3 ready), the offline map (working), the search walk (paused),
// the upload retry task (paused, test run in background), the SDK pin task (paused).
const HARBOR = 'w44:t3H'
const OFFLINE = 'w44:t3N'
const SEARCH = 'w44:t3B'
const UPLOAD = 'w44:t3F'
const SDK = 'w44:t3D'
const CAPTURED = { [SEARCH]: 'done', [SDK]: 'done', [UPLOAD]: 'done', [HARBOR]: 'done', [OFFLINE]: 'working' }

describe('band', () => {
  test('replays the demo home: what needs the captain, then every worker with its time', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const { first, crew } = await rowsOf(ui)
      expect(first).toBe('FIRSTMATE  Merge? the 1.4 release branch is beh…  https://github.com/example-org/harbor-api/pull/3  · 4 more need you')
      expect(crew).toBe('Just finished  the 1.4 release branch is beh…     Working  add the offline map     Waiting  walk the redesigned search pa…     +2 more')
      expect(await ui.find({ type: 'Text', text: '(beneath)' })).toBeDefined()
      await ui.unmount()
    }
    expect(world.writes).toEqual([])
  })

  test('says what the captain has to answer when no merge is waiting, oldest first', OPTIONS, async ($, on) => {
    const files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = []
    }))
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await rowsOf(ui)).first).toBe('FIRSTMATE  4 need you · oldest: Lighthouse: draft the privacy policy for Google Play and the App Store, 10 days')
  })

  test('says "Nothing needs you" when nothing does, and one call as one', OPTIONS, async ($, on) => {
    const none = inReplay(on, {
      ...DEMO_HOME,
      files: withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
        ;(doc.contributions as { captain: unknown[] }).captain = []
        doc.decisions_open = []
      })),
    })
    await started($, none)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await rowsOf(ui)).first).toBe('FIRSTMATE  Nothing needs you')
    await ui.unmount()
    none.files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = []
      doc.decisions_open = (doc.decisions_open as unknown[]).slice(0, 1)
    }))
    await none.clock.advance(30_000)
    const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await rowsOf(again)).first).toBe('FIRSTMATE  1 needs you · Lighthouse: draft the privacy policy for Google Play and the App Store, 10 days')
  })

  test('a call the captain parked with a date is not something that needs you', OPTIONS, async ($, on) => {
    const files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = []
      doc.decisions_open = (doc.decisions_open as { hold_bucket: string }[]).map(call => ({ ...call, hold_bucket: 'later' }))
    }))
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await rowsOf(ui)).first).toBe('FIRSTMATE  Nothing needs you')
  })

  test('puts the worst news first: stuck, just finished, working, waiting', OPTIONS, async ($, on) => {
    const epoch = captureEpoch(DEMO_HOME)
    const tabs = { ...CAPTURED, [SDK]: 'blocked', [UPLOAD]: 'working' } as Record<string, string>
    // The search walk's window is gone and its last word was "paused", not "done".
    delete tabs[SEARCH]
    const files = withFiles(DEMO_HOME, {
      'herdr/agent-list.json': agentList(tabs),
      'state/tidepool-upload-retry-c1.status': `working [at=${epoch - 7 * 60}]: items committed\n`,
    })
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 255 } })
    expect((await rowsOf(ui)).crew).toBe(
      'Stuck  walk the redesigned search pa…: window closed 37m · the release build pins an old…: question on its screen 18m' +
        '     Just finished  the 1.4 release branch is beh… <1m' +
        '     Working  a failed upload is retried 7m · add the offline map <1m',
    )
  })

  test('a quiet pane whose last word was "working" is stuck only after ten minutes', SLOW, async ($, on) => {
    const epoch = captureEpoch(DEMO_HOME)
    const files = withFiles(DEMO_HOME, {
      'herdr/agent-list.json': agentList({ ...CAPTURED, [UPLOAD]: 'working' }),
      'state/tidepool-upload-retry-c1.status': `working [at=${epoch - 60}]: items committed\n`,
    })
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    // Herdr sees the pane stop; the worker's last word is still "working".
    world.files = { ...world.files, 'herdr/agent-list.json': agentList(CAPTURED) }
    await world.clock.advance(60_000)
    const ui = async () => (await rowsOf(await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 255 } }))).crew
    expect(await ui()).toContain('a failed upload is retried <1m')
    expect(await ui()).not.toContain('Stuck')
    await world.clock.advance(9 * 60_000)
    expect(await ui()).toContain('a failed upload is retried 9m')
    await world.clock.advance(2 * 60_000)
    expect(await ui()).toContain('Stuck  a failed upload is retried: stopped without a word 11m')
  })

  test('names a worker that waits on Firstmate, and counts a resolved decision as work resumed', OPTIONS, async ($, on) => {
    const epoch = captureEpoch(DEMO_HOME)
    const files = withFiles(DEMO_HOME, {
      'state/tidepool-upload-retry-c1.status': `needs-decision [at=${epoch - 120}] [key=nm-1]: ask-user findings=a file=/x\n`,
      'state/lighthouse-sdk-pin-f1.status': `needs-decision [at=${epoch - 300}] [key=nm-2]: x\nresolved [at=${epoch - 200}] [key=nm-2]: decided\n`,
    })
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 255 } })
    const { crew } = await rowsOf(ui)
    expect(crew).toContain('a failed upload is retried: for Firstmate 2m')
    // A resolved decision reads as work resumed: the pane is quiet, so it is only stuck after ten minutes.
    expect(crew).toContain('Working  the release build pins an old… 3m')
  })

  test('shows "just finished" for an hour, then the worker leaves the band', SLOW, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const crew = async () => (await rowsOf(await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 255 } }))).crew
    expect(await crew()).toContain('Just finished  the 1.4 release branch is beh… <1m')
    await world.clock.advance(59 * 60_000)
    expect(await crew()).toContain('Just finished  the 1.4 release branch is beh… 59m')
    await world.clock.advance(2 * 60_000)
    expect(await crew()).not.toContain('Just finished')
  })

  test('keeps every group word and drops the times, then cuts workers into "+N more", at narrow widths', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const crewAt = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
      return (await rowsOf(ui)).crew!
    }
    const wide = await crewAt(255)
    expect(wide).toBe(
      'Just finished  the 1.4 release branch is beh… <1m     Working  add the offline map <1m     Waiting  walk the redesigned search pa… 37m · the release build pins an old… 18m · a failed upload is retried 4m',
    )
    const mid = await crewAt(175)
    for (const word of ['Just finished', 'Working', 'Waiting']) expect(mid).toContain(word)
    expect(mid).not.toMatch(/\d+m/)
    const narrow = await crewAt(60)
    expect(narrow).toMatch(/^Just finished {2}\S.*\+\d+ more$/)
    for (const width of [255, 175, 100, 60, 40]) expect((await crewAt(width)).length).toBeLessThanOrEqual(width)
  })

  test('wraps the first row at a narrow width without cutting the link', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 44 } })
    const all = (await textsOf(ui)).join('\n')
    expect(all).toContain('https://github.com/example-org/harbor-api/pull/3')
    expect(all).toContain('4 more need you')
    // The first row leaves room for the button beside it, so the surface truncates nothing.
    const first = (await textsOf(ui)).find(t => t.startsWith('FM'))
    const button = await ui.find({ key: 'open-fleet' })
    expect((first?.length ?? 99) + String(button?.props.label).length).toBeLessThanOrEqual(44)
  })

  test('gives up its rule first when the slot above the prompt is short', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, maxRows: 2 } })
      expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^FIRSTMATE/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('yields to a survey', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: /FIRSTMATE/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '(beneath)' })).toBeDefined()
  })

  test('says plainly when no home is configured, and reads nothing', async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /no home configured/ }))?.text).toMatch(/^FIRSTMATE/)
    expect(world.runs).toEqual([])
  })

  test("says it can't read Herdr rather than guessing a worker's state", OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME, { herdrFails: 'herdr: cannot connect to the server socket' })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await rowsOf(ui)).crew).toBe("can't read Herdr")
    expect(world.statuses.at(-1)).toBe('Herdr read failed: herdr agent list exited 1: herdr: cannot connect to the server socket')
  })

  test("says it can't read Firstmate's list when the summary was never readable", OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: withFiles(DEMO_HOME, { 'state/home-summary.json': null }) })
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const { first, crew } = await rowsOf(ui)
    expect(first).toBe("FIRSTMATE  can't read Firstmate's list")
    // Herdr is still read, so the crew row is still true.
    expect(crew).toMatch(/^Just finished/)
    expect(world.statuses.at(-1)).toMatch(/^Firstmate summary unreadable: cannot read state\/home-summary.json/)
  })

  test('carries no count, validity, presence or UTC wording', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 255 } })
    const all = (await textsOf(ui)).join('\n')
    for (const word of ['Alive', 'confirmed', 'recorded', 'panes', 'unreadable', 'Summary', 'main home', /\d\dZ/]) {
      expect(all).not.toMatch(typeof word === 'string' ? new RegExp(word) : word)
    }
  })
})
