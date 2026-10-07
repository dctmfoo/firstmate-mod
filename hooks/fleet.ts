// The fleet view: one pure fold of the lanes into what the band and the pane
// draw. Herdr supplies pane activity; the worker's own newest Firstmate status
// line says what a quiet pane means.

import type { CallRecord, CrewRecords, CrewWorker, HomeRecords, Lane, LandedRecord, MergeAsk, ProviderQuota, QuotaRecords } from '../types'
import { nameOf, splitTitle } from './normalize'

/** A worker whose status says `done` stays on the band this long. */
export const FINISHED_MS = 60 * 60_000

/** A quiet pane whose last status line still says working is stuck after this long. */
export const STOPPED_MS = 10 * 60_000

/** A provider at or below this much headroom gets a line in the pane. */
export const HEADROOM_LINE_PERCENT = 20

export type Lanes = {
  home: Lane<HomeRecords>
  crew: Lane<CrewRecords>
  quota: Lane<QuotaRecords>
}

export type Group = 'stuck' | 'finished' | 'working' | 'waiting'

/** Worst news first. */
export const GROUPS: Group[] = ['stuck', 'finished', 'working', 'waiting']

export const GROUP_LABELS: Record<Group, string> = {
  stuck: 'Stuck',
  finished: 'Just finished',
  working: 'Working',
  waiting: 'Waiting',
}

export type CrewRow = {
  id: string
  /** The plain name: the backlog title without its project prefix, cut to 30 columns. */
  name: string
  /** The project as the backlog title names it (`Lighthouse`), else the project directory. */
  project: string | null
  /** `Claude`, `Codex`, ... */
  agent: string | null
  group: Group
  /** Why a stuck or waiting worker is there, in plain words; null when the group says it all. */
  why: string | null
  /** Epoch ms the worker has been in this group since. */
  sinceMs: number
}

export type NeedItem =
  | { kind: 'merge'; name: string; url: string }
  | { kind: 'call'; call: CallRecord }

export type SummaryHealth = 'not-configured' | 'reading' | 'unreadable' | 'ok'

export type LowProvider = {
  provider: string
  percent: number
  /** The limiting window's label, e.g. `week`. */
  window: string | null
  resetsAtMs: number | null
}

export type FleetView = {
  home: string | null
  health: SummaryHealth
  /** Why the summary could not be read at all, or the newest failure beside a retained value. */
  summaryError: string | null
  /** Every item that needs the captain: merges first, then calls oldest first. */
  needs: NeedItem[]
  /** Calls the captain parked with a date (the published `later` bucket). */
  parked: CallRecord[]
  landed: LandedRecord[]
  crew: CrewRow[]
  /** `reading` until Herdr was read once; `unreadable` when it never was. */
  crewHealth: 'reading' | 'unreadable' | 'ok'
  crewError: string | null
  /** Providers at or below the headroom line, tightest first. */
  headroom: LowProvider[]
  quota: QuotaRecords | null
}

const isConfigured = (home: string | null): home is string => home !== null && home.startsWith('/')

const agentName = (agent: string | null): string | null =>
  agent === null || agent === '' ? null : agent.charAt(0).toUpperCase() + agent.slice(1)

/**
 * The join: Herdr's state for the pane, and for a pane that is not working the
 * worker's own newest status line. Returns null when the worker no longer
 * belongs on the band (finished more than an hour ago).
 */
export function groupOf(worker: CrewWorker, nowMs: number): { group: Group; why: string | null; sinceMs: number } | null {
  const status = worker.status
  const statusMs = status?.at == null ? worker.since : Math.min(nowMs, status.at * 1000)
  switch (worker.herdr) {
    case 'working':
    case 'unknown':
      return { group: 'working', why: null, sinceMs: worker.since }
    case 'blocked':
      return { group: 'stuck', why: 'question on its screen', sinceMs: worker.since }
    case 'gone':
      if (status?.state === 'done') return nowMs - statusMs > FINISHED_MS ? null : { group: 'finished', why: null, sinceMs: statusMs }
      return { group: 'stuck', why: 'window closed', sinceMs: worker.since }
    case 'quiet':
      break
  }
  switch (status?.state) {
    case 'paused':
      return { group: 'waiting', why: null, sinceMs: statusMs }
    case 'needs-decision':
      return { group: 'waiting', why: 'for Firstmate', sinceMs: statusMs }
    case 'blocked':
      return { group: 'stuck', why: 'blocked', sinceMs: statusMs }
    case 'failed':
      return { group: 'stuck', why: 'failed', sinceMs: statusMs }
    case 'done':
      return nowMs - statusMs > FINISHED_MS ? null : { group: 'finished', why: null, sinceMs: statusMs }
    default:
      // working, or no status line at all: a quiet pane that stays quiet has stopped without a word.
      if (nowMs - worker.since > STOPPED_MS) return { group: 'stuck', why: 'stopped without a word', sinceMs: worker.since }
      return { group: 'working', why: null, sinceMs: worker.since }
  }
}

function crewOf(records: CrewRecords | null, nowMs: number): CrewRow[] {
  if (records === null) return []
  const rows: CrewRow[] = []
  for (const worker of records.workers) {
    const joined = groupOf(worker, nowMs)
    if (joined === null) continue
    rows.push({
      id: worker.id,
      name: nameOf(worker.title, worker.id),
      project: (worker.title === null ? null : splitTitle(worker.title).project) ?? worker.project,
      agent: agentName(worker.agent ?? worker.harness),
      ...joined,
    })
  }
  const order = (row: CrewRow) => GROUPS.indexOf(row.group)
  return rows.sort((a, b) => order(a) - order(b) || a.sinceMs - b.sinceMs || a.name.localeCompare(b.name))
}

/** Distinct recorded calls for the captain, split by the published hold bucket; never reclassified here. */
function callsOf(home: HomeRecords | null): { live: CallRecord[]; later: CallRecord[] } {
  if (home === null) return { live: [], later: [] }
  const distinct = new Map<string, CallRecord>()
  for (const call of home.summary.decisionsOpen) {
    if (call.verb === 'captain-hold' && !distinct.has(call.key)) distinct.set(call.key, call)
  }
  const all = [...distinct.values()]
  const isLive = (call: CallRecord) => call.holdBucket === 'live' || call.holdBucket === null
  const oldestFirst = (a: CallRecord, b: CallRecord) => (b.holdAgeDays ?? -1) - (a.holdAgeDays ?? -1)
  return { live: all.filter(isLive).sort(oldestFirst), later: all.filter(call => !isLive(call)).sort(oldestFirst) }
}

function needsOf(home: HomeRecords | null, calls: CallRecord[], records: CrewRecords | null): NeedItem[] {
  if (home === null) return []
  const titles = new Map((records?.workers ?? []).map(w => [w.id, w.title]))
  const merges: NeedItem[] = []
  const seen = new Set<string>()
  const settled = (ask: MergeAsk) => home.settled.some(s => s.url === ask.url && s.task === ask.task)
  for (const ask of home.summary.merges) {
    // A pull request held with a date is already one of the calls; one URL is one merge.
    // One Firstmate's own records show settled is no longer the captain's, whatever the last forge poll said.
    if (ask.hold !== null || settled(ask) || seen.has(ask.url)) continue
    seen.add(ask.url)
    const task = ask.task ?? ''
    merges.push({ kind: 'merge', name: nameOf(titles.get(task) ?? null, task === '' ? 'pull request' : task), url: ask.url })
  }
  return [...merges, ...calls.map(call => ({ kind: 'call' as const, call }))]
}

function headroomOf(quota: QuotaRecords | null): LowProvider[] {
  if (quota === null) return []
  const out: LowProvider[] = []
  for (const provider of quota.providers) {
    const low = lowOf(provider)
    if (low !== null) out.push(low)
  }
  return out.sort((a, b) => a.percent - b.percent)
}

/** The provider's tightest fresh all-model limit, when it is at or below the headroom line. */
export function lowOf(provider: ProviderQuota): LowProvider | null {
  const all = provider.effective.find(e => e.scope === 'all_models')
  const percent = all?.effectivePercentRemaining ?? null
  if (provider.isStale === true || provider.status !== 'fresh' || percent === null || percent > HEADROOM_LINE_PERCENT) return null
  const window = provider.windows.find(w => w.id === all?.limitingWindowIds[0])
  const resets = window?.resetsAt == null ? Number.NaN : Date.parse(window.resetsAt)
  return { provider: provider.provider, percent, window: window?.label ?? all?.limitingWindowIds[0] ?? null, resetsAtMs: Number.isFinite(resets) ? resets : null }
}

function healthOf(home: string | null, lane: Lane<HomeRecords>): SummaryHealth {
  if (!isConfigured(home)) return 'not-configured'
  if (lane.value !== null) return 'ok'
  return lane.error === null ? 'reading' : 'unreadable'
}

/** The whole fleet view for one moment. */
export function fleetViewOf(home: string | null, lanes: Lanes, nowMs: number): FleetView {
  const records = lanes.home.value
  const calls = callsOf(records)
  return {
    home,
    health: healthOf(home, lanes.home),
    summaryError: lanes.home.error?.reason ?? null,
    needs: needsOf(records, calls.live, lanes.crew.value),
    parked: calls.later,
    landed: records?.summary.landed ?? [],
    crew: crewOf(lanes.crew.value, nowMs),
    crewHealth: lanes.crew.value !== null ? 'ok' : lanes.crew.error === null ? 'reading' : 'unreadable',
    crewError: lanes.crew.error?.reason ?? null,
    headroom: headroomOf(lanes.quota.value),
    quota: lanes.quota.value,
  }
}
