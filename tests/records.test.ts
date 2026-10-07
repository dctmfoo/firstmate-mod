// The record readers and the fleet fold, as plain functions: what each record
// becomes, how a Herdr state joins a status line, and how a worker is named.

import { describe, expect, test } from 'claude-code/testing'

import { fleetViewOf, FINISHED_MS, groupOf, type Lanes, STOPPED_MS } from '../hooks/fleet'
import { backlogClosedOf, backlogTitlesOf, herdrAgentsOf, herdrStateOf, metaOf, nameOf, quotaOf, splitTitle, statusLineOf, summaryOf, summaryRefusal } from '../hooks/normalize'
import { daysText, durationText, packRow, pathRows, seg } from '../hooks/text'
import { EMPTY_LEDGER, transition } from '../hooks/toasts'
import type { CrewWorker, HerdrState, StatusLine } from '../types'
import { DEMO_HOME } from './fixtures/demo-home'

const NOW = Date.parse('2026-10-04T18:57:01Z')
const NOW_S = Math.floor(NOW / 1000)

const lane = <T>(value: T) => ({ value, readAt: NOW, error: null })
const empty = { value: null, readAt: null, error: null }

function worker(herdr: HerdrState, status: StatusLine | null, since = NOW, id = 'w1-s1'): CrewWorker {
  return { id, project: 'p', harness: 'claude', agent: 'claude', title: null, herdr, status, since }
}

describe('readers', () => {
  test('metadata gives the project basename, the harness and the Herdr tab', () => {
    expect(metaOf('project=/a/b/firstmate-mod\nharness=codex\nkind=ship\nherdr_tab_id=w44:t3N\nherdr_pane_id=w44:p3P\n')).toEqual({
      project: 'firstmate-mod',
      harness: 'codex',
      herdrTabId: 'w44:t3N',
      spawnedAt: null,
    })
    expect(metaOf('project=\n').herdrTabId).toBeNull()
    expect(metaOf('spawn_gen=s1791139797.6818.17640\n').spawnedAt).toBe(1791139797)
    expect(metaOf('spawn_gen=oops\n').spawnedAt).toBeNull()
  })

  test('the Herdr agent list keeps tab, pane, agent and status; any other document is refused', () => {
    const doc = JSON.stringify({ result: { agents: [{ agent: 'codex', agent_status: 'working', pane_id: 'w1:p1', tab_id: 'w1:t1', cwd: '/x' }, { agent: 'claude' }] } })
    expect(herdrAgentsOf(doc)).toEqual([{ tabId: 'w1:t1', paneId: 'w1:p1', agent: 'codex', status: 'working' }])
    expect(() => herdrAgentsOf('{}')).toThrow('no agents list')
    expect(() => herdrAgentsOf('nope')).toThrow()
  })

  test("Herdr's words fold to working, blocked, quiet or unknown; idle and done are both quiet", () => {
    expect(['working', 'blocked', 'idle', 'done', 'unknown', 'something-new'].map(herdrStateOf)).toEqual(['working', 'blocked', 'quiet', 'quiet', 'unknown', 'unknown'])
  })

  test('the newest typed status line wins; resolved means work resumed; other lines are ignored', () => {
    expect(statusLineOf('working [at=10]: a\npaused [at=20]: b\n')).toEqual({ state: 'paused', at: 20 })
    expect(statusLineOf('needs-decision [at=10] [key=nm-1]: x\nresolved [at=30] [key=nm-1]: y\n')).toEqual({ state: 'working', at: 30 })
    expect(statusLineOf('done [at=5]: PR https://github.com/x/y/pull/1 checks green\nsome stray prose\n')).toEqual({ state: 'done', at: 5 })
    expect(statusLineOf('done: no time\n')).toEqual({ state: 'done', at: null })
    expect(statusLineOf('')).toBeNull()
    expect(statusLineOf('chatter only\n')).toBeNull()
  })

  test('the backlog gives each task its title, first listing wins', () => {
    const titles = backlogTitlesOf('# Backlog\n- [ ] a-s1 - Proj: do a thing (repo: p) (kind: ship)\n  note\n- [x] b-s1 - other\n- [ ] a-s1 - again\n')
    expect([...titles]).toEqual([['a-s1', 'Proj: do a thing (repo: p) (kind: ship)'], ['b-s1', 'other']])
  })

  test('the backlog says which tasks are closed; the first row for an id wins', () => {
    const closed = backlogClosedOf('- [x] a-s1 - done one\n- [ ] b-s1 - open one\n- [X] c-s1 - also done\n- [ ] a-s1 - again\nnot a task row\n')
    expect([...closed]).toEqual([['a-s1', true], ['b-s1', false], ['c-s1', true]])
  })

  test('a name is the title without its project, cut at the first ; , or ( and then to 30 columns', () => {
    expect(splitTitle('Atlas Docs Team: search walk')).toEqual({ project: 'Atlas Docs Team', text: 'search walk' })
    expect(splitTitle('no prefix here')).toEqual({ project: null, text: 'no prefix here' })
    expect(splitTitle('Fix a, then: other').project).toBeNull()
    expect(nameOf('Harbor API: the 1.4 release branch is behind main; backport the cache fix', 'x')).toBe('the 1.4 release branch is beh…')
    expect(nameOf('Tidepool: a failed upload is retried, never dropped (items 1-9)', 'x')).toBe('a failed upload is retried')
    expect(nameOf('Lighthouse: add the offline map (saved forecasts, sync on reconnect)', 'x')).toBe('add the offline map')
    expect(nameOf('plain title', 'x')).toBe('plain title')
    expect(nameOf('Proj: (only a parenthetical)', 'task-s1')).toBe('task-s1')
    expect(nameOf(null, 'task-s1')).toBe('task-s1')
    expect(nameOf('x'.repeat(40), 'id').length).toBe(30)
  })

  test('the summary keeps calls, landings and the captain\'s merges, and only its own schema is read', () => {
    const doc = JSON.parse(DEMO_HOME.files['state/home-summary.json']!) as Record<string, unknown>
    expect(summaryRefusal(doc)).toBeNull()
    expect(summaryRefusal({ schema: 'other' })).toMatch(/is not fm-secondmate-home-summary.v1/)
    expect(summaryRefusal([])).toMatch(/not a JSON object/)
    const summary = summaryOf(doc)
    expect(summary.decisionsOpen.map(c => c.key)).toContain('lighthouse-privacy-policy-s1')
    expect(summary.merges).toEqual([{ task: 'harbor-backport-14-f2', url: 'https://github.com/example-org/harbor-api/pull/3', hold: null }])
    expect(summary.landed[0]).toMatchObject({ verb: 'reported', date: '2026-10-05' })
  })

  test('quota output keeps provider, windows, freshness and the tightest limit', () => {
    const quota = quotaOf(DEMO_HOME.files['quota.json']!)
    expect(quota.providers.map(p => p.provider)).toEqual(['claude', 'codex'])
    expect(quota.providers[1]!.effective.find(e => e.scope === 'all_models')?.limitingWindowIds.length).toBeGreaterThan(0)
    expect(() => quotaOf('{}')).toThrow('no providers list')
  })
})

describe('the join: Herdr state with the worker\'s own newest status line', () => {
  const at = (state: StatusLine['state'], agoMs: number): StatusLine => ({ state, at: NOW_S - Math.round(agoMs / 1000) })
  const join = (herdr: HerdrState, status: StatusLine | null, since = NOW) => groupOf(worker(herdr, status, since), NOW)

  test('working is Working whatever the last line says, timed from when Herdr turned working', () => {
    expect(join('working', at('paused', 3_600_000), NOW - 120_000)).toEqual({ group: 'working', why: null, sinceMs: NOW - 120_000 })
    expect(join('working', null)).toMatchObject({ group: 'working' })
    expect(join('unknown', null)).toMatchObject({ group: 'working' })
  })

  test('blocked is Stuck with a question on its screen', () => {
    expect(join('blocked', at('working', 1000), NOW - 5000)).toEqual({ group: 'stuck', why: 'question on its screen', sinceMs: NOW - 5000 })
  })

  test('a quiet pane reads its last line: paused is Waiting, needs-decision waits for Firstmate, blocked and failed are Stuck', () => {
    expect(join('quiet', at('paused', 600_000))).toEqual({ group: 'waiting', why: null, sinceMs: NOW - 600_000 })
    expect(join('quiet', at('needs-decision', 60_000))).toEqual({ group: 'waiting', why: 'for Firstmate', sinceMs: NOW - 60_000 })
    expect(join('quiet', at('blocked', 60_000))).toEqual({ group: 'stuck', why: 'blocked', sinceMs: NOW - 60_000 })
    expect(join('quiet', at('failed', 60_000))).toEqual({ group: 'stuck', why: 'failed', sinceMs: NOW - 60_000 })
  })

  test('a quiet pane after "done" is Just finished for an hour, then gone from the band', () => {
    expect(join('quiet', at('done', 60_000))).toEqual({ group: 'finished', why: null, sinceMs: NOW - 60_000 })
    expect(join('quiet', at('done', FINISHED_MS - 1000))?.group).toBe('finished')
    expect(join('quiet', at('done', FINISHED_MS + 1000))).toBeNull()
  })

  test('a quiet pane after "working" or nothing is Working for ten minutes, then Stuck without a word', () => {
    expect(join('quiet', at('working', 3_600_000), NOW - STOPPED_MS + 1000)).toMatchObject({ group: 'working' })
    expect(join('quiet', at('working', 3_600_000), NOW - STOPPED_MS - 1000)).toEqual({ group: 'stuck', why: 'stopped without a word', sinceMs: NOW - STOPPED_MS - 1000 })
    expect(join('quiet', null, NOW - STOPPED_MS - 1000)).toMatchObject({ group: 'stuck', why: 'stopped without a word' })
  })

  test('no pane: Stuck "window closed" unless the worker said done', () => {
    expect(join('gone', at('paused', 120_000), NOW - 90_000)).toEqual({ group: 'stuck', why: 'window closed', sinceMs: NOW - 90_000 })
    expect(join('gone', null)).toMatchObject({ group: 'stuck', why: 'window closed' })
    expect(join('gone', at('done', 60_000))).toMatchObject({ group: 'finished' })
    expect(join('gone', at('done', FINISHED_MS + 1000))).toBeNull()
  })
})

describe('fleet fold', () => {
  function lanesOf(edit: (doc: Record<string, unknown>) => void = () => {}, workers: CrewWorker[] = []): Lanes {
    const doc = JSON.parse(DEMO_HOME.files['state/home-summary.json']!) as Record<string, unknown>
    edit(doc)
    return {
      home: lane({ home: '/replay/demo-home', summary: summaryOf(doc), settled: [] }),
      crew: lane({ workers }),
      quota: lane(quotaOf(DEMO_HOME.files['quota.json']!)),
    }
  }

  test('needs: merges first, then live calls oldest first; a merge held as a call is the call', () => {
    const view = fleetViewOf('/h', lanesOf(doc => {
      ;(doc.contributions as { captain: unknown[] }).captain = [
        { task: 'a-s1', url: 'https://github.com/o/r/pull/1' },
        { task: 'a-s1', url: 'https://github.com/o/r/pull/1' },
        { task: 'b-s1', url: 'https://github.com/o/r/pull/2', hold: 'b-hold' },
      ]
    }), NOW)
    expect(view.needs.map(n => (n.kind === 'merge' ? `merge ${n.url}` : `call ${n.call.key}`))).toEqual([
      'merge https://github.com/o/r/pull/1',
      'call lighthouse-privacy-policy-s1',
      'call harbor-staging-key-rotation',
      'call atlas-await-hosting-quote',
      'call tidepool-storage-tier-decision',
    ])
  })

  test('parked calls are the published later bucket; only captain holds count', () => {
    const view = fleetViewOf('/h', lanesOf(doc => {
      doc.decisions_open = [
        { id: 'a', key: 'a', verb: 'captain-hold', hold_bucket: 'later', hold_age_days: 2 },
        { id: 'b', key: 'b', verb: 'worker-question', hold_bucket: 'live' },
        { id: 'c', key: 'c', verb: 'captain-hold', hold_bucket: 'live' },
        { id: 'c', key: 'c', verb: 'captain-hold', hold_bucket: 'live' },
      ]
    }), NOW)
    expect(view.parked.map(c => c.key)).toEqual(['a'])
    expect(view.needs.map(n => (n.kind === 'call' ? n.call.key : n.url)).filter(k => k !== 'https://github.com/example-org/harbor-api/pull/3')).toEqual(['c'])
  })

  test('a merge is named by its worker\'s title when it has one, else its task id', () => {
    const named = { ...worker('quiet', { state: 'done', at: NOW_S }, NOW, 'harbor-backport-14-f2'), title: 'Harbor API: ship the line' }
    const view = fleetViewOf('/h', lanesOf(undefined, [named]), NOW)
    expect(view.needs[0]).toEqual({ kind: 'merge', name: 'ship the line', url: 'https://github.com/example-org/harbor-api/pull/3' })
    expect(fleetViewOf('/h', lanesOf(), NOW).needs[0]).toMatchObject({ name: 'harbor-backport-14-f2' })
  })

  test('crew rows sort stuck, just finished, working, waiting, longest in state first', () => {
    const rows = fleetViewOf('/h', lanesOf(undefined, [
      worker('quiet', { state: 'paused', at: NOW_S - 100 }, NOW, 'w-s1'),
      worker('working', null, NOW - 60_000, 'a-s1'),
      worker('working', null, NOW - 120_000, 'b-s1'),
      worker('blocked', null, NOW, 'c-s1'),
      worker('quiet', { state: 'done', at: NOW_S - 5 }, NOW, 'd-s1'),
    ]), NOW).crew
    expect(rows.map(r => `${r.group}:${r.id}`)).toEqual(['stuck:c-s1', 'finished:d-s1', 'working:b-s1', 'working:a-s1', 'waiting:w-s1'])
  })

  test('no configured home, or a relative one, is not configured; an unread home is reading', () => {
    expect(fleetViewOf(null, { home: empty, crew: empty, quota: empty }, NOW).health).toBe('not-configured')
    expect(fleetViewOf('relative/home', { home: empty, crew: empty, quota: empty }, NOW).health).toBe('not-configured')
    expect(fleetViewOf('/h', { home: empty, crew: empty, quota: empty }, NOW)).toMatchObject({ health: 'reading', crewHealth: 'reading' })
    expect(fleetViewOf('/h', { home: { ...empty, error: { reason: 'x', at: NOW } }, crew: empty, quota: empty }, NOW).health).toBe('unreadable')
  })

  test('headroom is a provider\'s fresh tightest limit at or below 20%', () => {
    const quota = JSON.parse(DEMO_HOME.files['quota.json']!) as { providers: { quotaSemantics: { effectiveAvailability: { effectivePercentRemaining: number }[] } }[] }
    expect(fleetViewOf('/h', lanesOf(), NOW).headroom).toEqual([])
    quota.providers[1]!.quotaSemantics.effectiveAvailability[0]!.effectivePercentRemaining = 20
    const view = fleetViewOf('/h', { ...lanesOf(), quota: lane(quotaOf(JSON.stringify(quota))) }, NOW)
    expect(view.headroom.map(h => [h.provider, h.percent])).toEqual([['codex', 20]])
  })
})

describe('text', () => {
  test('a long URL breaks after a slash and joins back whole', () => {
    const url = 'https://github.com/example-org/lighthouse/pull/4529'
    const rows = pathRows(url, 24)
    expect(rows.every(row => row.length <= 24)).toBe(true)
    expect(rows.join('')).toBe(url)
    expect(pathRows(url, 80)).toEqual([url])
  })

  test('a row abbreviates before it wraps, and wraps between segments', () => {
    const segs = [seg('FIRSTMATE', 'brand', 'FM'), seg('Nothing needs you'), seg('and more words')]
    expect(packRow(segs, 80, '  ').map(l => l.map(s => s.text).join(''))).toEqual(['FIRSTMATE  Nothing needs you  and more words'])
    expect(packRow(segs, 30, '  ').map(l => l.map(s => s.text).join(''))).toEqual(['FM  Nothing needs you', 'and more words'])
  })

  test('durations read in minutes, hours and days; days read as a person says them', () => {
    expect([0, 59_000, 60_000, 12 * 60_000, 59 * 60_000 + 59_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000].map(durationText)).toEqual(['<1m', '<1m', '1m', '12m', '59m', '1h', '47h', '2d'])
    expect([0, 1, 10].map(daysText)).toEqual(['today', '1 day', '10 days'])
  })
})

describe('toast ledger', () => {
  test('a read with nothing new keeps the very same ledger, so it is not written again', () => {
    const candidates = [{ key: 'call:a', text: 'a' }]
    const baselined = transition(EMPTY_LEDGER, 'needs', candidates).ledger
    expect(transition(baselined, 'needs', candidates).ledger).toBe(baselined)
    expect(transition(baselined, 'needs', null).ledger).toBe(baselined)
    const stuck = transition(transition(EMPTY_LEDGER, 'stuck', []).ledger, 'stuck', [{ key: 'stuck:w:blocked', text: 'w' }])
    expect(stuck.toasts).toEqual(['w'])
    // A worker that got unstuck drops its key: that is a change.
    expect(transition(stuck.ledger, 'stuck', []).ledger).not.toBe(stuck.ledger)
  })
})
