// The /fm-fleet pane: one view. What needs the captain,
// then every worker by state (stuck, working, waiting, just finished), then
// what is parked with the captain and any provider that is low on headroom.
// Plain terminal text; every URL is shown whole.

import type { CallRecord } from '../types'
import { type CrewRow, type FleetView, type Group, type LowProvider, type NeedItem } from './fleet'
import { NAME_COLUMNS, splitTitle } from './normalize'
import { clip, daysText, durationText, harnessName, type Line, packRow, pathRows, seg } from './text'

export type PaneItem =
  | { kind: 'header' }
  | { kind: 'line'; line: Line; indent?: number }
  | { kind: 'gap' }
  | { kind: 'discuss'; call: CallRecord }

/** At this width a worker row also shows its project and harness. */
const WIDE = 64

const PROJECT_COLUMNS = 14

/** How many parked calls are named before the rest are counted. */
const PARKED_SHOWN = 5

const line = (text: string, tone: 'plain' | 'muted' | 'warn' | 'head' = 'plain', indent?: number): PaneItem =>
  indent === undefined ? { kind: 'line', line: [seg(text, tone)] } : { kind: 'line', line: [seg(text, tone)], indent }

const gap = (): PaneItem => ({ kind: 'gap' })

const heading = (text: string): PaneItem => line(text, 'head')

/** `2026-10-05` in the machine's own time zone, for "today". */
function localDay(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

function needItems(item: NeedItem, width: number): PaneItem[] {
  if (item.kind === 'merge') {
    return [
      line(`Merge? ${clip(item.name, width - 9)}`, 'plain', 2),
      ...pathRows(item.url, Math.max(8, width - 4)).map(row => line(row, 'plain', 4)),
    ]
  }
  const { call } = item
  const age = call.holdAgeDays === null ? '' : daysText(call.holdAgeDays)
  const text = call.summary ?? call.key
  const room = Math.max(8, width - 2 - (age === '' ? 0 : age.length + 2))
  const row: Line = [seg(clip(text, room))]
  if (age !== '') row.push(seg(`  ${age}`, 'muted'))
  return [{ kind: 'line', line: row, indent: 2 }, { kind: 'discuss', call }]
}

function crewItems(row: CrewRow, width: number, nowMs: number): PaneItem[] {
  const time = durationText(nowMs - row.sinceMs)
  const items: PaneItem[] = []
  if (width >= WIDE) {
    const project = clip(row.project ?? '', PROJECT_COLUMNS).padEnd(PROJECT_COLUMNS + 1)
    items.push({
      kind: 'line',
      indent: 2,
      line: [seg(row.name.padEnd(NAME_COLUMNS + 2)), seg(project, 'muted'), seg(time.padStart(4)), seg(row.agent === null ? '' : `  ${row.agent}`, 'muted')],
    })
  } else {
    const room = Math.max(8, width - 2 - time.length - 2)
    items.push({ kind: 'line', indent: 2, line: [seg(clip(row.name, room)), seg(`  ${time}`, 'muted')] })
  }
  if (row.why !== null) items.push(line(row.why, row.group === 'stuck' ? 'warn' : 'muted', 4))
  return items
}

function section(view: FleetView, group: Group, title: string, width: number, nowMs: number, isAlways: boolean): PaneItem[] {
  const rows = view.crew.filter(row => row.group === group)
  if (rows.length === 0 && !isAlways) return []
  return [
    gap(),
    heading(title),
    ...(rows.length === 0 ? [line('(none)', 'muted', 2)] : rows.flatMap(row => crewItems(row, width, nowMs))),
  ]
}

const VERB_WORDS: Record<string, string> = { merged: 'merged', reported: 'report' }

function landedItems(view: FleetView, width: number, nowMs: number): PaneItem[] {
  const today = localDay(nowMs)
  const crewIds = new Set(view.crew.map(row => row.id))
  const items: PaneItem[] = []
  for (const landed of view.landed) {
    if (landed.date !== today || crewIds.has(landed.id)) continue
    const verb = (landed.verb === null ? (landed.kind ?? '') : (VERB_WORDS[landed.verb] ?? landed.verb)).padEnd(8)
    const title = splitTitle(landed.title ?? landed.id).text
    items.push({ kind: 'line', indent: 2, line: [seg(verb, 'muted'), seg(clip(title, Math.max(8, width - 10)))] })
    if (landed.prUrl !== null) items.push(...pathRows(landed.prUrl, Math.max(8, width - 10)).map(row => line(row, 'plain', 10)))
  }
  return items
}

const resetText = (low: LowProvider, nowMs: number) =>
  low.resetsAtMs === null ? '' : `, resets in ${durationText(low.resetsAtMs - nowMs)}`

/** The pane as items for `width` columns, at `nowMs`. */
export function paneItems(view: FleetView, width: number, nowMs: number): PaneItem[] {
  const items: PaneItem[] = [{ kind: 'header' }]
  if (view.health === 'not-configured') {
    return [...items, gap(), line('No home configured: set the firstmate-mod "home" option.', 'muted')]
  }

  items.push(gap(), heading(`NEEDS YOU${view.needs.length === 0 ? '' : ` (${view.needs.length})`}`))
  if (view.health === 'unreadable') items.push(line("Can't read Firstmate's list", 'warn', 2))
  else if (view.health === 'reading') items.push(line('reading Firstmate…', 'muted', 2))
  else if (view.needs.length === 0) items.push(line('Nothing needs you', 'plain', 2))
  else items.push(...view.needs.flatMap(item => needItems(item, width)))

  if (view.crewHealth === 'ok') {
    const finished = section(view, 'finished', 'JUST FINISHED', width, nowMs, false)
    const landed = landedItems(view, width, nowMs)
    items.push(
      ...section(view, 'stuck', 'STUCK', width, nowMs, true),
      ...section(view, 'working', 'WORKING', width, nowMs, false),
      ...section(view, 'waiting', 'WAITING', width, nowMs, false),
    )
    if (finished.length > 0 || landed.length > 0) {
      items.push(...(finished.length > 0 ? finished : [gap(), heading('JUST FINISHED')]), ...landed)
    }
    if (view.crew.length === 0) items.push(gap(), line('No workers running', 'muted'))
  } else {
    items.push(gap(), heading('CREW'), line(view.crewHealth === 'reading' ? 'reading Herdr…' : `Can't read Herdr${view.crewError === null ? '' : `: ${view.crewError}`}`, view.crewHealth === 'reading' ? 'muted' : 'warn', 2))
  }

  if (view.parked.length > 0) {
    const names = view.parked.slice(0, PARKED_SHOWN).map(call => clip(splitTitle(call.summary ?? call.key).text, NAME_COLUMNS))
    const hidden = view.parked.length - names.length
    const segs = names.map((name, i) => seg(i === 0 ? `Parked with you: ${name}` : name))
    if (hidden > 0) segs.push(seg(`+${hidden} more`, 'muted'))
    items.push(gap(), ...packRow(segs, width, ' · ').map(row => ({ kind: 'line' as const, line: row })))
  }
  for (const low of view.headroom) {
    const window = low.window === null ? '' : ` (${low.window}${resetText(low, nowMs)})`
    items.push(gap(), line(`Low on headroom: ${harnessName(low.provider)} ${low.percent}% left${window}`, 'warn'))
  }
  return items
}
