// A replay home served beneath the mod: its files answer $.fs, its
// stored `herdr agent list` and quota output answer $.process.run, and
// everything the mod tries to change is kept so a test can assert on it.

import type { Args, On } from 'claude-code'
import { mock } from 'claude-code/testing'

export type Replay = {
  capture: { started?: string; ended?: string; source_home?: string; commands?: string[] }
  /** Paths relative to the home: state/…, data/backlog.md, herdr/agent-list.json, quota.json. */
  files: Record<string, string>
}

export const HOME = '/replay/demo-home'

export const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

export type World = ReturnType<typeof inReplay>

/** A cheap stand-in for a file's mtime: it moves whenever the text does. */
const mtimeOf = (text: string) => {
  let hash = text.length
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 2_147_483_647
  return hash
}

/** The replay's capture end, the clock a test starts at. */
export const endedMs = (replay: Replay) => Date.parse(replay.capture.ended ?? '2026-10-04T12:00:00Z')

/**
 * Serves `replay` as the home at HOME. `files` may be replaced on the returned
 * world to move the home on to another capture mid-test.
 */
export function inReplay(on: On, replay: Replay, options: { now?: number; quotaFails?: string; herdrFails?: string; toastFails?: string } = {}) {
  const world = {
    files: { ...replay.files } as Record<string, string>,
    runs: [] as Args<'process.run'>[],
    /** Paths relative to the home, one per file read. */
    reads: [] as string[],
    lists: [] as string[],
    /** Paths relative to the home, one per stat. */
    stats: [] as string[],
    writes: [] as Args<'fs.write'>[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    opened: [] as Args<'ui.open'>[],
    fills: [] as Args<'prompt.fill'>[],
    commands: [] as string[],
    clock: mock.clock(on, { now: options.now ?? endedMs(replay) }),
  }
  const rel = (path: string) => (path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : null)

  on('fs.read', (_$, e) => {
    const key = rel(e.path)
    if (key !== null) world.reads.push(key)
    const text = key === null ? undefined : world.files[key]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', (_$, e) => {
    const key = rel(e.path)
    if (key !== null) world.stats.push(key)
    const text = key === null ? undefined : world.files[key]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimeOf(text), isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const key = rel(e.path)
    if (key === null) return { deny: `ENOENT: ${e.path}` }
    world.lists.push(key)
    const entries = new Map<string, { kind: 'file' | 'dir'; size: number; mtimeMs: number }>()
    for (const [path, text] of Object.entries(world.files)) {
      if (!path.startsWith(`${key}/`)) continue
      const rest = path.slice(key.length + 1)
      const name = rest.split('/')[0]
      if (name === undefined) continue
      // As the engine lists: a file's size and mtime come with the listing, a directory's mtime is 0.
      entries.set(name, rest.includes('/') ? { kind: 'dir', size: 0, mtimeMs: 0 } : { kind: 'file', size: text.length, mtimeMs: mtimeOf(text) })
    }
    return { value: [...entries].map(([name, entry]) => ({ name, ...entry, isLink: false })) }
  })
  on('fs.write', (_$, e) => {
    world.writes.push(e)
    return { deny: 'the replay home is read-only' }
  })
  on('process.run', async (_$, e) => {
    world.runs.push(e)
    const [command, ...args] = e.argv
    const done = (stdout: string, exitCode = 0, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (command === 'herdr') {
      if (args.join(' ') !== 'agent list') return { deny: `not a replay command: ${e.argv.join(' ')}` }
      if (options.herdrFails !== undefined) return done('', 1, options.herdrFails)
      return done(world.files['herdr/agent-list.json'] ?? '')
    }
    if (command === 'quota-axi') {
      if (options.quotaFails !== undefined) return done('', 1, options.quotaFails)
      return done(world.files['quota.json'] ?? '')
    }
    return { deny: `not a replay command: ${e.argv.join(' ')}` }
  })
  on('ui.toast', (_$, e) => {
    if (options.toastFails !== undefined) return { deny: options.toastFails }
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('prompt.fill', (_$, e) => {
    world.fills.push(e)
    return { isFilled: true }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  // What the engine and any other mod would draw beneath the band.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['(beneath)'] }))
  return world
}

/** Starts the session and lets every lane's first read land. */
export async function started($: { session: { start: (e: typeof SESSION) => Promise<unknown> } }, world: World) {
  await $.session.start(SESSION)
  await world.clock.advance(1)
  await world.clock.settle()
}

/** The capture's end in epoch seconds: the clock a replay starts at. */
export const captureEpoch = (replay: Replay) => Math.floor(endedMs(replay) / 1000)

/** A `herdr agent list` document from tab id to Herdr's status word; a tab left out has no pane. */
export function agentList(tabs: Record<string, string>): string {
  return JSON.stringify({
    id: 'cli:agent:list',
    result: {
      type: 'agent_list',
      agents: Object.entries(tabs).map(([tabId, status], i) => ({ agent: 'claude', agent_status: status, pane_id: `w44:p${i}`, tab_id: tabId })),
    },
  })
}

/** The replay's files with edits applied: a string sets a file, null removes it. */
export function withFiles(replay: Replay, edits: Record<string, string | null>): Record<string, string> {
  const files = { ...replay.files }
  for (const [path, text] of Object.entries(edits)) {
    if (text === null) delete files[path]
    else files[path] = text
  }
  return files
}

/** The replay's summary with one edit applied, as a files entry. */
export function summaryEdit(replay: Replay, edit: (doc: Record<string, unknown>) => void): Record<string, string> {
  const doc = JSON.parse(replay.files['state/home-summary.json']!) as Record<string, unknown>
  edit(doc)
  return { 'state/home-summary.json': JSON.stringify(doc) }
}
