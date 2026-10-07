import { describe, expect, test } from 'claude-code/testing'

import { DEMO_HOME } from './fixtures/demo-home'
import { agentList, HOME, inReplay, started, summaryEdit, withFiles } from './fixtures/replay'

// Engine-backed rendering and timer advances need room on a busy host.
const OPTIONS = { timeoutMs: 30_000, options: { home: HOME } }

const paneOf = (placement: 'dock' | 'inline', bodyColumns: number) =>
  ({
    plugin: 'firstmate-mod',
    component: 'Pane',
    requestId: 'firstmate-fleet',
    viewport: { columns: placement === 'dock' ? 180 : bodyColumns + 4, rows: 50, isFullscreen: placement === 'dock' },
    props: {
      title: 'Firstmate',
      isFocused: true,
      bodyColumns,
      placement,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const linesOf = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

const HARBOR = 'w44:t3H'
const OFFLINE = 'w44:t3N'
const SEARCH = 'w44:t3B'
const UPLOAD = 'w44:t3F'
const SDK = 'w44:t3D'
const CAPTURED = { [SEARCH]: 'done', [SDK]: 'done', [UPLOAD]: 'done', [HARBOR]: 'done', [OFFLINE]: 'working' }

/** Asserts `words` appear in `text` in this order. */
function inOrder(text: string, words: string[]) {
  let at = -1
  for (const word of words) {
    const next = text.indexOf(word, at + 1)
    expect(next, `"${word}" after position ${at}`).toBeGreaterThan(at)
    at = next
  }
}

describe('pane', () => {
  test('draws the band in full, in the band\'s order: needs you, stuck, working, waiting, just finished', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...paneOf('dock', 72), surface })
      const all = (await linesOf(ui)).join('\n')
      inOrder(all, [
        'FIRSTMATE',
        'NEEDS YOU (5)',
        'Merge? the 1.4 release branch is beh…',
        'https://github.com/example-org/harbor-api/pull/3',
        'Lighthouse: draft the privacy policy for Google Play and the…  10 days',
        'Harbor API: rotate the staging API key so the load test can r…  8 days',
        'STUCK',
        '(none)',
        'WORKING',
        'add the offline map',
        'WAITING',
        'walk the redesigned search pa…',
        'JUST FINISHED',
        'the 1.4 release branch is beh…',
      ])
      expect(all).toContain('Atlas Docs')
      expect(all).toContain('Claude')
      await ui.unmount()
    }
  })

  test('is one view: no tabs, no counts, no delivery or headroom tables', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    for (const word of ['Fleet', 'Calls', 'Delivery', 'Snapshot', 'panes present', 'Alive', 'confirmed', 'recorded', 'Summary', 'UTC']) {
      expect(all).not.toContain(word)
    }
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
  })

  test('Discuss puts an editable draft in the prompt box and sends nothing', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    await ui.press({ key: 'discuss-lighthouse-privacy-policy-s1' })
    expect(world.fills).toHaveLength(1)
    expect(world.fills[0]).toMatchObject({ mode: 'insert' })
    expect(world.fills[0]?.text).toContain('lighthouse-privacy-policy-s1')
    expect(world.fills[0]?.text.endsWith('My thoughts: ')).toBe(true)
    expect(world.writes).toEqual([])
  })

  test('opens inline in a narrow terminal and shows a link whole', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('inline', 40), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    // A URL wider than the pane breaks after a slash, whole, rather than being cut.
    expect(all.replace(/\n/g, '')).toContain('https://github.com/example-org/harbor-api/pull/3')
    expect(all).toContain('NEEDS YOU (5)')
    expect(all).toContain('WAITING')
  })

  test('lists a stuck worker with its reason, and every other worker with its time', OPTIONS, async ($, on) => {
    const tabs = { ...CAPTURED, [SDK]: 'blocked' } as Record<string, string>
    const world = inReplay(on, { ...DEMO_HOME, files: withFiles(DEMO_HOME, { 'herdr/agent-list.json': agentList(tabs) }) })
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    inOrder(all, ['STUCK', 'the release build pins an old…', 'question on its screen', 'WORKING'])
    expect(all).not.toContain('(none)')
    expect(all).toMatch(/the release build pins an old… +Lighthouse +18m +Claude/)
  })

  test('says when nothing needs the captain, and names what was parked', OPTIONS, async ($, on) => {
    const files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = []
      doc.decisions_open = [
        { id: 'a-s1', key: 'a-s1', verb: 'captain-hold', summary: 'Tidepool: constraint gate', hold_bucket: 'later', hold_age_days: 4 },
        { id: 'b-s1', key: 'b-s1', verb: 'captain-hold', summary: 'Harbor API: scope decision', hold_bucket: 'later', hold_age_days: 2 },
      ]
    }))
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    inOrder(all, ['NEEDS YOU', 'Nothing needs you', 'STUCK', 'Parked with you: constraint gate'])
    expect(all).toContain('Parked with you: constraint gate · scope decision')
    expect(all).not.toContain('NEEDS YOU (')
  })

  test('lists what landed today, merges with their full link', OPTIONS, async ($, on) => {
    const noon = Date.parse('2026-10-05T10:00:00Z')
    const files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      doc.landed = [
        { id: 'x-merge', title: 'Lighthouse: remove the legacy forecast cache; never show stale data', kind: 'ship', pr_url: 'https://github.com/example-org/lighthouse/pull/486', completion: { verb: 'merged', date: '2026-10-05' } },
        { id: 'x-report', title: 'Atlas Docs: redesign the results list', kind: 'scout', pr_url: null, completion: { verb: 'reported', date: '2026-10-05' } },
        { id: 'x-old', title: 'Lighthouse: yesterday', kind: 'ship', pr_url: 'https://github.com/example-org/lighthouse/pull/1', completion: { verb: 'merged', date: '2026-10-04' } },
      ]
    }))
    const world = inReplay(on, { ...DEMO_HOME, files }, { now: noon })
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    inOrder(all, ['JUST FINISHED', 'merged  remove the legacy forecast cache; never show stale data', 'https://github.com/example-org/lighthouse/pull/486', 'report  redesign the results list'])
    expect(all).not.toContain('yesterday')
  })

  test('adds one line only when a provider is low on headroom', OPTIONS, async ($, on) => {
    const quota = JSON.parse(DEMO_HOME.files['quota.json']!) as { providers: { quotaSemantics: { effectiveAvailability: { effectivePercentRemaining: number }[] } }[] }
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    let ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    expect((await linesOf(ui)).join('\n')).not.toContain('headroom')
    await ui.unmount()
    quota.providers[1]!.quotaSemantics.effectiveAvailability[0]!.effectivePercentRemaining = 7
    world.files = { ...world.files, 'quota.json': JSON.stringify(quota) }
    await world.clock.advance(900_000)
    ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    expect((await linesOf(ui)).join('\n')).toMatch(/Low on headroom: Codex 7% left \(week, resets in \d+[mhd]\)/)
  })

  test('says Herdr could not be read, with its words, instead of drawing workers', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME, { herdrFails: 'no server socket' })
    await started($, world)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    const all = (await linesOf(ui)).join('\n')
    expect(all).toContain("Can't read Herdr: herdr agent list exited 1: no server socket")
    expect(all).not.toContain('WORKING')
  })

  test('ages every worker from its own status line while the pane stays open', OPTIONS, async ($, on) => {
    const world = inReplay(on, DEMO_HOME)
    await started($, world)
    await world.clock.advance(5 * 60_000)
    const ui = await $.ui.mount({ ...paneOf('dock', 72), surface: 'terminal' })
    expect((await linesOf(ui)).join('\n')).toMatch(/walk the redesigned search pa… +Atlas Docs +42m/)
  })
})
