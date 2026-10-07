// A merge ask Firstmate's own records show settled leaves NEEDS YOU at the next
// summary read, without waiting for the forge poll that rewrites the summary.

import { describe, expect, test } from 'claude-code/testing'

import { DEMO_HOME } from './fixtures/demo-home'
import { HOME, inReplay, started, summaryEdit, withFiles } from './fixtures/replay'

const OPTIONS = { options: { home: HOME } }

const SUMMARY_MS = 30_000

const TASK = 'atlas-dark-mode-b2'
const URL = 'https://github.com/example-org/atlas-docs/pull/2'
const ROW = `${TASK} - Atlas Docs: dark mode for the docs site (repo: atlas-docs) (kind: ship)`

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

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }

const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

/** The demo home with the summary's only need being this one merge ask, as the last forge poll left it. */
function home(edits: Record<string, string | null> = {}) {
  const summary = summaryEdit(DEMO_HOME, doc => {
    ;(doc.contributions as { captain: unknown[] }).captain = [{ task: TASK, url: URL }]
    doc.decisions_open = []
  })
  const backlog = `${DEMO_HOME.files['data/backlog.md']!}\n- [ ] ${ROW} (since 2026-10-04)\n`
  return withFiles(DEMO_HOME, { ...summary, 'data/backlog.md': backlog, [`state/${TASK}.meta`]: 'project=atlas-docs\nharness=claude\nkind=ship\n', ...edits })
}

const closedRow = (suffix = '(merged 2026-10-05)') => `${DEMO_HOME.files['data/backlog.md']!}\n- [x] ${ROW} ${suffix}\n`

/** The band's first row, mounted fresh from the lanes as they stand. */
async function firstRow($: { ui: { mount: (init: never) => Promise<Ui & { unmount: () => unknown }> } }) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  const first = (await texts(ui)).find(t => t.startsWith('FIRSTMATE'))
  await ui.unmount()
  return first
}

describe('a settled merge ask', () => {
  test('leaves NEEDS YOU, band, pane and toasts once the task closes, though the summary still lists it', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home() })
    await started($, world)
    expect(await firstRow($)).toBe(`FIRSTMATE  Merge? ${TASK}  ${URL}`)

    // The merge lands and the task closes; the summary is untouched, so it still says "merge approval needed".
    world.files = home({ 'data/backlog.md': closedRow(), [`state/${TASK}.meta`]: null })
    await world.clock.advance(SUMMARY_MS)
    await world.clock.advance(SUMMARY_MS)

    expect(await firstRow($)).toBe('FIRSTMATE  Nothing needs you')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = (await texts(pane)).join('\n')
    expect(all).toContain('Nothing needs you')
    expect(all).not.toContain('NEEDS YOU (')
    expect(all).not.toContain(URL)
    expect(world.toasts).toEqual([])
    expect(world.writes).toEqual([])
  })

  test('is never shown when the first read already finds the task closed', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home({ 'data/backlog.md': closedRow(), [`state/${TASK}.meta`]: null }) })
    await started($, world)
    expect(await firstRow($)).toBe('FIRSTMATE  Nothing needs you')
  })

  test('goes when the backlog closes the task even while its metadata lingers', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home({ 'data/backlog.md': closedRow('(done 2026-10-05)') }) })
    await started($, world)
    expect(await firstRow($)).toBe('FIRSTMATE  Nothing needs you')
  })

  test('goes when the task has no live record: no metadata and no backlog row', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home({ 'data/backlog.md': DEMO_HOME.files['data/backlog.md']!, [`state/${TASK}.meta`]: null }) })
    await started($, world)
    expect(await firstRow($)).toBe('FIRSTMATE  Nothing needs you')
  })
})

describe('a merge ask that is still live', () => {
  test('stays when the backlog cannot be read: nothing is inferred from a record that is missing', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home({ 'data/backlog.md': null, [`state/${TASK}.meta`]: null }) })
    await started($, world)
    expect(await firstRow($)).toBe(`FIRSTMATE  Merge? ${TASK}  ${URL}`)
  })

  test('stays when its open backlog row has no worker metadata', OPTIONS, async ($, on) => {
    const world = inReplay(on, { ...DEMO_HOME, files: home({ [`state/${TASK}.meta`]: null }) })
    await started($, world)
    expect(await firstRow($)).toBe(`FIRSTMATE  Merge? ${TASK}  ${URL}`)
  })

  test('stays when the summary names no task, and never reads a path from an unsafe task id', OPTIONS, async ($, on) => {
    const files = withFiles(DEMO_HOME, summaryEdit(DEMO_HOME, doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = [{ url: URL }, { task: '../x', url: `${URL}0` }]
      doc.decisions_open = []
    }))
    const world = inReplay(on, { ...DEMO_HOME, files })
    await started($, world)
    expect(await firstRow($)).toBe(`FIRSTMATE  Merge? pull request  ${URL}  · 1 more need you`)
    expect(world.reads.filter(path => path.includes('..'))).toEqual([])
  })
})
