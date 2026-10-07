// The firstmate-mod state contract: what the mod keeps in $.state, and the
// read-only records it normalizes.
//
// These are normalized source records; the joined view is derived separately
// in hooks/fleet.ts.

/** One lane's latest read: the value it last read, when, and the last failure. */
export type Lane<T> = {
  /** The last value read successfully, or null before the first one. */
  value: T | null
  /** Epoch milliseconds of that successful read, or null. */
  readAt: number | null
  /** The newest failure, kept beside an older good value; null once a read succeeds. */
  error: { reason: string; at: number } | null
}

/** state/<id>.meta, the fields the mod reads. */
export type TaskMeta = {
  /** The project directory's basename. */
  project: string | null
  harness: string | null
  /** The Herdr tab this worker runs in; the join key to `herdr agent list`. */
  herdrTabId: string | null
  /** Epoch seconds the task was spawned, from `spawn_gen`; null when absent. */
  spawnedAt: number | null
}

/** home-summary.json decisions_open[]: one recorded call for the captain. */
export type CallRecord = {
  id: string
  key: string
  verb: string | null
  summary: string | null
  reason: string | null
  holdBucket: string | null
  holdAgeDays: number | null
}

/** home-summary.json landed[]: one bounded recent completion. */
export type LandedRecord = {
  id: string
  title: string | null
  kind: string | null
  prUrl: string | null
  verb: string | null
  date: string | null
}

/** home-summary.json contributions.captain[]: a pull request that is the captain's to merge. */
export type MergeAsk = {
  task: string | null
  url: string
  /** The Firstmate hold that already records this as a call, or null for a plain merge. */
  hold: string | null
}

/** state/home-summary.json (fm-secondmate-home-summary.v1), the parts the band and pane use. */
export type SummaryRecord = {
  schema: string
  generated: string | null
  generatedEpoch: number | null
  decisionsOpen: CallRecord[]
  landed: LandedRecord[]
  merges: MergeAsk[]
}

/** A merge ask the summary still lists although the home's own records show it settled. */
export type SettledMerge = {
  task: string
  url: string
}

/** The summary lane: the home it read and what it found there. */
export type HomeRecords = {
  home: string
  summary: SummaryRecord
  /** Merge asks in the summary that the task's own records show settled; the summary only catches up at the next forge poll. */
  settled: SettledMerge[]
}

/** One record of `herdr agent list`. */
export type HerdrAgent = {
  tabId: string
  paneId: string | null
  /** claude, codex, ... */
  agent: string | null
  /** Herdr's own word: idle, working, blocked, done or unknown. */
  status: string
}

/** What Herdr says about one worker's pane. `gone` is a pane missing from the list. */
export type HerdrState = 'working' | 'blocked' | 'quiet' | 'unknown' | 'gone'

export type StatusState = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed'

/** The newest typed line of state/<id>.status. */
export type StatusLine = {
  state: StatusState
  /** Epoch seconds from `[at=…]`, or null when the line has none. */
  at: number | null
}

/** One worker: its Herdr state joined with its newest status line and its name. */
export type CrewWorker = {
  id: string
  project: string | null
  harness: string | null
  /** The Herdr agent kind of its pane, when the pane is listed. */
  agent: string | null
  /** The backlog title as written, or null when the backlog does not list the task. */
  title: string | null
  herdr: HerdrState
  status: StatusLine | null
  /** Epoch ms of the observed Herdr transition, initially seeded from status or spawn time. */
  since: number
}

/** The crew lane: every worker whose task metadata names a Herdr tab. */
export type CrewRecords = {
  workers: CrewWorker[]
}

export type QuotaWindow = {
  id: string
  label: string | null
  kind: string | null
  resetsAt: string | null
  percentRemaining: number | null
}

export type QuotaEffective = {
  scope: string
  status: string | null
  effectivePercentRemaining: number | null
  limitingWindowIds: string[]
}

export type ProviderQuota = {
  provider: string
  plan: string | null
  status: string | null
  isStale: boolean | null
  windows: QuotaWindow[]
  effective: QuotaEffective[]
  error: string | null
}

/** quota-axi --json, normalized. */
export type QuotaRecords = {
  generatedAt: string | null
  providers: ProviderQuota[]
}

/** What has already been announced; deduplication is owned by hooks/toasts.ts. */
export type ToastLedger = {
  /** Kinds whose first baseline has been taken: nothing in a baseline toasts. */
  baselined: string[]
  /** Dedupe keys already seen, newest last, bounded. */
  seen: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'firstmate-mod': {
      home: Lane<HomeRecords>
      crew: Lane<CrewRecords>
      quota: Lane<QuotaRecords>
      ledger: ToastLedger
    }
  }
}
