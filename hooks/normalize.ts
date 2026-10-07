// Pure readers from the records the mod uses to its typed shapes.
//
// These normalize transport only: a field of the wrong type becomes null, an
// unknown word stays the word, a bounded list stays bounded. They never grade,
// infer or rewrite what Herdr or Firstmate recorded.

import type {
  CallRecord,
  HerdrAgent,
  HerdrState,
  LandedRecord,
  MergeAsk,
  ProviderQuota,
  QuotaRecords,
  StatusLine,
  StatusState,
  SummaryRecord,
  TaskMeta,
} from '../types'
import { clip } from './text'

export const SUMMARY_SCHEMA = 'fm-secondmate-home-summary.v1'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const bool = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const strings = (value: unknown): string[] =>
  list(value).filter((item): item is string => typeof item === 'string')

const present = <T>(items: (T | null)[]): T[] =>
  items.filter((item): item is T => item !== null)

/** Why a summary document cannot be used, or null when it can. */
export function summaryRefusal(doc: unknown): string | null {
  if (!isObject(doc)) return 'home summary is not a JSON object'
  if (doc.schema !== SUMMARY_SCHEMA) {
    return `home summary schema ${JSON.stringify(doc.schema ?? null)} is not ${SUMMARY_SCHEMA}`
  }
  return null
}

function callOf(item: unknown): CallRecord | null {
  if (!isObject(item) || typeof item.id !== 'string') return null
  return {
    id: item.id,
    key: str(item.key) ?? item.id,
    verb: str(item.verb),
    summary: str(item.summary),
    reason: str(item.reason),
    holdBucket: str(item.hold_bucket),
    holdAgeDays: num(item.hold_age_days),
  }
}

function landedOf(item: unknown): LandedRecord | null {
  if (!isObject(item) || typeof item.id !== 'string') return null
  const completion = isObject(item.completion) ? item.completion : {}
  return {
    id: item.id,
    title: str(item.title),
    kind: str(item.kind),
    prUrl: str(item.pr_url),
    verb: str(completion.verb),
    date: str(completion.date),
  }
}

function mergeOf(item: unknown): MergeAsk | null {
  if (!isObject(item)) return null
  const url = str(item.url)
  if (url === null) return null
  return { task: str(item.task), url, hold: str(item.hold) }
}

/** The published summary document, normalized; call summaryRefusal first. */
export function summaryOf(doc: Json): SummaryRecord {
  const contributions = isObject(doc.contributions) ? doc.contributions : {}
  return {
    schema: SUMMARY_SCHEMA,
    generated: str(doc.generated),
    generatedEpoch: num(doc.generated_epoch),
    decisionsOpen: present(list(doc.decisions_open).map(callOf)),
    landed: present(list(doc.landed).map(landedOf)),
    merges: present(list(contributions.captain).map(mergeOf)),
  }
}

/** `spawn_gen=s1791139797.6818.17640` as epoch seconds. */
const spawnedAtOf = (gen: string | null): number | null => {
  const match = gen === null ? null : /^s(\d+)\./.exec(gen)
  return match === null ? null : Number(match[1])
}

/** state/<id>.meta: `key=value` lines; the fields the mod reads, project by its basename. */
export function metaOf(text: string): TaskMeta {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const field = (name: string) => {
    const value = fields.get(name)
    return value === undefined || value === '' ? null : value
  }
  const project = field('project')
  return {
    project: project === null ? null : (project.split('/').filter(Boolean).pop() ?? null),
    harness: field('harness'),
    herdrTabId: field('herdr_tab_id'),
    spawnedAt: spawnedAtOf(field('spawn_gen')),
  }
}

/** `herdr agent list` JSON, normalized; throws when it is not the expected document. */
export function herdrAgentsOf(text: string): HerdrAgent[] {
  const doc: unknown = JSON.parse(text)
  const result = isObject(doc) && isObject(doc.result) ? doc.result : null
  if (result === null || !Array.isArray(result.agents)) throw new Error('no agents list')
  return present(
    result.agents.map(item =>
      isObject(item) && typeof item.tab_id === 'string'
        ? { tabId: item.tab_id, paneId: str(item.pane_id), agent: str(item.agent), status: str(item.agent_status) ?? 'unknown' }
        : null,
    ),
  )
}

/** Herdr's status word as a state: idle and done are both a pane that is not working. */
export function herdrStateOf(status: string): HerdrState {
  switch (status) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'idle':
    case 'done':
      return 'quiet'
    default:
      return 'unknown'
  }
}

const STATUS_LINE = /^(working|needs-decision|blocked|paused|done|failed|resolved)\b(?:[^\n]*?\[at=(\d+)\])?/

/**
 * The newest typed line of a status file. A `resolved` line means the worker
 * went on, so it reads as working; lines of any other shape are ignored.
 */
export function statusLineOf(text: string): StatusLine | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = STATUS_LINE.exec(lines[i]!.trim())
    if (match === null) continue
    const word = match[1]!
    return { state: (word === 'resolved' ? 'working' : word) as StatusState, at: match[2] === undefined ? null : Number(match[2]) }
  }
  return null
}

/** The backlog's task titles by id: every `- [ ] <id> - <title>` or `- [x] <id> - <title>` line. */
export function backlogTitlesOf(text: string): Map<string, string> {
  const titles = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^- \[[ xX]\] (\S+) - (.*)$/.exec(line)
    if (match !== null && !titles.has(match[1]!)) titles.set(match[1]!, match[2]!.slice(0, 300))
  }
  return titles
}

/** Whether the backlog row of each task is closed (`- [x]`) or open; the first row for an id wins. */
export function backlogClosedOf(text: string): Map<string, boolean> {
  const closed = new Map<string, boolean>()
  for (const line of text.split('\n')) {
    const match = /^- \[([ xX])\] (\S+) - /.exec(line)
    if (match !== null && !closed.has(match[2]!)) closed.set(match[2]!, match[1] !== ' ')
  }
  return closed
}

/** A title split into its project prefix (`Lighthouse: …`) and the rest. */
export function splitTitle(title: string): { project: string | null; text: string } {
  const match = /^([^:;,(]{1,30}):\s+(\S[\s\S]*)$/.exec(title)
  return match === null ? { project: null, text: title } : { project: match[1]!.trim(), text: match[2]! }
}

export const NAME_COLUMNS = 30

/**
 * A worker's plain name: the backlog title without its project prefix, cut at
 * the first `;`, `,` or `(`, then to 30 columns. The task id when there is no title.
 */
export function nameOf(title: string | null, id: string): string {
  if (title === null) return clip(id, NAME_COLUMNS)
  const cut = splitTitle(title).text.split(/[;,(]/)[0]!.trim()
  return clip(cut === '' ? id : cut, NAME_COLUMNS)
}

function providerOf(item: unknown): ProviderQuota | null {
  if (!isObject(item) || typeof item.provider !== 'string') return null
  const state = isObject(item.state) ? item.state : {}
  const semantics = isObject(item.quotaSemantics) ? item.quotaSemantics : {}
  return {
    provider: item.provider,
    plan: str(item.plan),
    status: str(state.status),
    isStale: bool(state.stale),
    windows: list(item.windows)
      .filter(isObject)
      .flatMap(w =>
        typeof w.id === 'string'
          ? [
              {
                id: w.id,
                label: str(w.label),
                kind: str(w.kind),
                resetsAt: str(w.resetsAt),
                percentRemaining: num(w.percentRemaining),
              },
            ]
          : [],
      ),
    effective: list(semantics.effectiveAvailability)
      .filter(isObject)
      .flatMap(row =>
        typeof row.scope === 'string'
          ? [
              {
                scope: row.scope,
                status: str(row.status),
                effectivePercentRemaining: num(row.effectivePercentRemaining),
                limitingWindowIds: strings(row.limitingWindowIds),
              },
            ]
          : [],
      ),
    error: str(item.error) ?? (isObject(item.error) ? str(item.error.message) : null),
  }
}

/** quota-axi --json output, normalized; throws when it is not the expected document. */
export function quotaOf(text: string): QuotaRecords {
  const doc: unknown = JSON.parse(text)
  if (!isObject(doc) || !Array.isArray(doc.providers)) {
    throw new Error('quota output has no providers list')
  }
  return {
    generatedAt: str(doc.generatedAt),
    providers: present(doc.providers.map(providerOf)),
  }
}
