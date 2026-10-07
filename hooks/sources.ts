// The read-only adapter. Every read here is a file read, a directory listing,
// a stat, or one of two read commands run by argv (`herdr agent list` and
// quota-axi); nothing writes, dispatches, steers, resolves or merges.

import type { FsEntry, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { CrewRecords, CrewWorker, HomeRecords, MergeAsk, QuotaRecords, SettledMerge, StatusLine, TaskMeta } from '../types'
import { backlogClosedOf, backlogTitlesOf, herdrAgentsOf, herdrStateOf, metaOf, quotaOf, statusLineOf, summaryOf, summaryRefusal } from './normalize'

/** What the adapter needs from the engine: reads, a listing, a stat, a run, the time. */
export type Host = {
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<FsEntry[]>
  mtime: (path: string) => Promise<number | null>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  now: () => Promise<number>
}

/** A task id as Firstmate writes them; anything else is never put on a path. */
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const HERDR_TIMEOUT_MS = 5_000
export const QUOTA_TIMEOUT_MS = 20_000

export const HERDR_ARGS = ['agent', 'list'] as const
export const QUOTA_ARGS = ['--provider', 'claude,codex', '--json', '--no-credential-refresh'] as const

export const summaryPath = (home: string) => `${home}/state/home-summary.json`
export const statePath = (home: string) => `${home}/state`
export const metaPath = (home: string, id: string) => `${home}/state/${id}.meta`
export const statusPath = (home: string, id: string) => `${home}/state/${id}.status`
export const backlogPath = (home: string) => `${home}/data/backlog.md`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Backlog text shared by both lanes while a known mtime holds; an unknown mtime forces a read. */
export type BacklogMemo = { entry: { mtimeMs: number; text: string } | null }

export const newBacklogMemo = (): BacklogMemo => ({ entry: null })

async function backlogText(host: Host, home: string, memo: BacklogMemo): Promise<string> {
  const path = backlogPath(home)
  const mtimeMs = await host.mtime(path)
  if (mtimeMs !== null && memo.entry?.mtimeMs === mtimeMs) return memo.entry.text
  const text = await host.read(path)
  memo.entry = mtimeMs === null ? null : { mtimeMs, text }
  return text
}

/**
 * The merge asks the summary still lists that Firstmate's own records show
 * settled: the task is closed in the backlog, or it has no live record (no
 * metadata and no backlog row). The summary only drops the ask at the next
 * forge poll, so the captain would keep being asked about a merge already done.
 * An unreadable backlog proves nothing. A failed state listing prevents only
 * the absence check; an explicitly closed backlog row still settles the ask.
 */
async function settledOf(host: Host, home: string, memo: BacklogMemo, asks: MergeAsk[]): Promise<SettledMerge[]> {
  const asked = asks.filter(ask => ask.hold === null && ask.task !== null && TASK_ID.test(ask.task))
  if (asked.length === 0) return []
  const closed = await backlogText(host, home, memo).then(backlogClosedOf, () => null)
  if (closed === null) return []
  const live = await host.list(statePath(home)).then(
    entries => new Set(entries.filter(entry => entry.name.endsWith('.meta')).map(entry => entry.name.slice(0, -'.meta'.length))),
    () => null,
  )
  const settled: SettledMerge[] = []
  for (const { task, url } of asked as { task: string; url: string }[]) {
    if (closed.get(task) === true || (live !== null && !closed.has(task) && !live.has(task))) settled.push({ task, url })
  }
  return settled
}

/** The summary lane: the published summary. */
export async function readHome(host: Host, home: string, memo: BacklogMemo = newBacklogMemo()): Promise<HomeRecords> {
  let text: string
  try {
    text = await host.read(summaryPath(home))
  } catch (error) {
    throw new Error(`cannot read state/home-summary.json (${messageOf(error)})`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('state/home-summary.json is not JSON')
  }
  const refusal = summaryRefusal(doc)
  if (refusal !== null) throw new Error(refusal)
  const summary = summaryOf(doc as Record<string, unknown>)
  return { home, summary, settled: await settledOf(host, home, memo, summary.merges) }
}

/** What the crew lane remembers between reads, so each file is read only when it changed. */
export type CrewCache = {
  /** Each task's metadata with the mtime it was read at; read again when the listing shows a new mtime. */
  metas: Map<string, { mtimeMs: number; meta: TaskMeta }>
  statuses: Map<string, { mtimeMs: number; line: StatusLine | null }>
  /** Backlog title by task id; null once the backlog was read and does not list the task. */
  titles: Map<string, string | null>
  /** The backlog text the titles were taken from; a different text names every worker afresh. */
  titlesFrom: string | null
  /** The backlog text, shared with the summary lane. */
  backlog: BacklogMemo
}

export const newCrewCache = (): CrewCache => ({ metas: new Map(), statuses: new Map(), titles: new Map(), titlesFrom: null, backlog: newBacklogMemo() })

/**
 * Refresh titles for already-seen workers too, so a late backlog entry or
 * rename does not leave a task id or old title cached forever. BacklogMemo
 * avoids rereading while a known mtime holds.
 */
async function readTitles(host: Host, home: string, cache: CrewCache, ids: string[]) {
  if (ids.length === 0) return
  let text: string
  try {
    text = await backlogText(host, home, cache.backlog)
  } catch {
    // The backlog is read again at the next tick; until then names stay as they were, or the task id.
    return
  }
  if (text !== cache.titlesFrom) {
    cache.titles.clear()
    cache.titlesFrom = text
  }
  const missing = ids.filter(id => !cache.titles.has(id))
  if (missing.length === 0) return
  const titles = backlogTitlesOf(text)
  for (const id of missing) cache.titles.set(id, titles.get(id) ?? null)
}

/** A file's mtime from the state listing; a non-file entry (a link) is stat'ed; null when absent. */
async function mtimeIn(host: Host, listed: Map<string, FsEntry>, path: string, name: string): Promise<number | null> {
  const entry = listed.get(name)
  if (entry === undefined) return null
  return entry.kind === 'file' ? entry.mtimeMs : host.mtime(path)
}

async function statusOf(host: Host, home: string, cache: CrewCache, listed: Map<string, FsEntry>, id: string): Promise<StatusLine | null> {
  const path = statusPath(home, id)
  const mtimeMs = await mtimeIn(host, listed, path, `${id}.status`)
  if (mtimeMs === null) {
    cache.statuses.delete(id)
    return null
  }
  const kept = cache.statuses.get(id)
  if (kept !== undefined && kept.mtimeMs === mtimeMs) return kept.line
  try {
    const line = statusLineOf(await host.read(path))
    cache.statuses.set(id, { mtimeMs, line })
    return line
  } catch {
    return kept?.line ?? null
  }
}

/** Metadata cached by listing mtime; a failed read keeps the cache, or returns null on first read. */
async function metaFor(host: Host, home: string, cache: CrewCache, entry: FsEntry, id: string): Promise<TaskMeta | null> {
  const kept = cache.metas.get(id)
  if (kept !== undefined && kept.mtimeMs === entry.mtimeMs) return kept.meta
  try {
    const meta = metaOf(await host.read(metaPath(home, id)))
    cache.metas.set(id, { mtimeMs: entry.mtimeMs, meta })
    return meta
  } catch {
    // Read again at the next tick; a worker whose metadata was read before keeps it meanwhile.
    return kept?.meta ?? null
  }
}

/**
 * The time a worker has been in its Herdr state: unchanged while the state
 * holds, the time of this read when it changed, and, the first time the worker
 * is seen, the newest status line's own time (Herdr keeps none), or the time
 * it was spawned when it has not written a status line yet.
 */
function sinceOf(prev: CrewWorker | undefined, herdr: CrewWorker['herdr'], status: StatusLine | null, spawnedAt: number | null, nowMs: number): number {
  if (prev !== undefined) return prev.herdr === herdr ? prev.since : nowMs
  const seed = status?.at ?? spawnedAt
  return seed == null ? nowMs : Math.min(nowMs, seed * 1000)
}

/**
 * The crew lane: one `herdr agent list` read, joined by tab id with each
 * worker's task metadata and newest status line. Workers are the tasks whose
 * state/<id>.meta names a Herdr tab; a worker whose tab holds no listed agent
 * is `gone`. Nothing here reads a screen.
 */
export async function readCrew(
  host: Host,
  home: string,
  herdrCommand: string,
  cache: CrewCache,
  prev: CrewRecords | null,
  nowMs: number,
): Promise<CrewRecords> {
  const ran = await host.run([herdrCommand, ...HERDR_ARGS], { timeoutMs: HERDR_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    throw new Error(`${herdrCommand} agent list exited ${ran.exitCode}${ran.stderr.trim() === '' ? '' : `: ${ran.stderr.trim().split('\n')[0]}`}`)
  }
  let agents: ReturnType<typeof herdrAgentsOf>
  try {
    agents = herdrAgentsOf(ran.stdout)
  } catch (error) {
    throw new Error(`${herdrCommand} agent list output unreadable (${messageOf(error)})`)
  }
  const byTab = new Map<string, (typeof agents)[number]>()
  const rank = (status: string) => (status === 'blocked' ? 0 : status === 'working' ? 1 : 2)
  for (const agent of agents) {
    const kept = byTab.get(agent.tabId)
    if (kept === undefined || rank(agent.status) < rank(kept.status)) byTab.set(agent.tabId, agent)
  }

  // Regular-file mtimes come from one listing, avoiding a stat per worker.
  const entries = await host.list(statePath(home))
  const listed = new Map(entries.map(entry => [entry.name, entry]))
  const metaEntries = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.meta'))
    .map(entry => ({ entry, id: entry.name.slice(0, -'.meta'.length) }))
    .filter(({ id }) => TASK_ID.test(id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids = new Set(metaEntries.map(({ id }) => id))
  const metas = await Promise.all(metaEntries.map(({ entry, id }) => metaFor(host, home, cache, entry, id)))
  const tracked: { id: string; meta: TaskMeta }[] = []
  metaEntries.forEach(({ id }, i) => {
    const meta = metas[i]
    if (meta != null && meta.herdrTabId !== null) tracked.push({ id, meta })
  })
  const live = new Set(tracked.map(t => t.id))
  for (const id of [...cache.metas.keys()]) if (!ids.has(id)) cache.metas.delete(id)
  for (const id of [...cache.statuses.keys()]) if (!live.has(id)) cache.statuses.delete(id)
  for (const id of [...cache.titles.keys()]) if (!live.has(id)) cache.titles.delete(id)
  await readTitles(host, home, cache, tracked.map(t => t.id))

  const before = new Map((prev?.workers ?? []).map(w => [w.id, w]))
  const statuses = await Promise.all(tracked.map(({ id }) => statusOf(host, home, cache, listed, id)))
  const workers: CrewWorker[] = tracked.map(({ id, meta }, i) => {
    const agent = byTab.get(meta.herdrTabId!)
    const herdr = agent === undefined ? 'gone' : herdrStateOf(agent.status)
    const status = statuses[i] ?? null
    return {
      id,
      project: meta.project,
      harness: meta.harness,
      agent: agent?.agent ?? null,
      title: cache.titles.get(id) ?? null,
      herdr,
      status,
      since: sinceOf(before.get(id), herdr, status, meta.spawnedAt, nowMs),
    }
  })
  return { workers }
}

/** The quota lane: one quota-axi JSON read, credentials never refreshed. */
export async function readQuota(host: Host, command: string, cwd: string | undefined): Promise<QuotaRecords> {
  const ran = await host.run([command, ...QUOTA_ARGS], {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: QUOTA_TIMEOUT_MS,
  })
  if (ran.exitCode !== 0 && ran.stdout.trim() === '') {
    throw new Error(`${command} exited ${ran.exitCode}${ran.stderr.trim() === '' ? '' : `: ${ran.stderr.trim().split('\n')[0]}`}`)
  }
  try {
    return quotaOf(ran.stdout)
  } catch (error) {
    throw new Error(`${command} output unreadable (${messageOf(error)})`)
  }
}
