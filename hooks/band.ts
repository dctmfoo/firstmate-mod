// The band above the prompt: two quiet rows. The first says what needs the
// captain, or that nothing does; a ready merge shows its full PR link. The
// second names every worker in plain words with how long it has been in its
// current state, worst first. Narrow widths drop the times, then end the row
// in "+N more"; a link or a name is never cut.

import { type CrewRow, type FleetView, type Group, GROUP_LABELS, GROUPS, type NeedItem } from './fleet'
import { clip, daysText, durationText, type Line, packRow, seg, type Seg } from './text'

const GAP = '  '
const ITEM_SEP = ' · '
const GROUP_GAP = '     '

/** The least a clipped call summary is cut to, however narrow the row. */
const MIN_SUMMARY = 12

const brand = () => seg('FIRSTMATE', 'brand', 'FM')

const callText = (item: Extract<NeedItem, { kind: 'call' }>) => item.call.summary ?? item.call.key

/** The band's first row, before packing: what needs the captain. */
export function needsSegs(view: FleetView, width: number): Seg[] {
  switch (view.health) {
    case 'not-configured':
      return [brand(), seg('no home configured: set the firstmate-mod "home" option', 'muted', 'no home configured')]
    case 'reading':
      return [brand(), seg('reading Firstmate…', 'muted')]
    case 'unreadable':
      return [brand(), seg("can't read Firstmate's list", 'warn')]
    case 'ok':
      break
  }
  const [first] = view.needs
  if (first === undefined) return [brand(), seg('Nothing needs you')]
  const more = view.needs.length - 1
  if (first.kind === 'merge') {
    const segs = [brand(), seg(`Merge? ${first.name}`), seg(first.url)]
    if (more > 0) segs.push(seg(`${ITEM_SEP.trim()} ${more} more need you`))
    return segs
  }
  const calls = view.needs.filter((item): item is Extract<NeedItem, { kind: 'call' }> => item.kind === 'call')
  const oldest = calls[0]!
  const head = view.needs.length === 1 ? `1 needs you${ITEM_SEP}` : `${view.needs.length} need you${ITEM_SEP}oldest: `
  const age = oldest.call.holdAgeDays === null ? '' : `, ${daysText(oldest.call.holdAgeDays)}`
  const room = Math.max(MIN_SUMMARY, width - 'FIRSTMATE'.length - GAP.length - head.length - age.length)
  return [brand(), seg(`${head}${clip(callText(oldest), room)}${age}`)]
}

function itemSegs(row: CrewRow, nowMs: number, isTimed: boolean): Seg[] {
  const segs: Seg[] = [seg(row.name)]
  if (row.why !== null) segs.push(seg(`: ${row.why}`, row.group === 'stuck' ? 'warn' : 'muted'))
  if (isTimed) segs.push(seg(` ${durationText(nowMs - row.sinceMs)}`, 'muted'))
  return segs
}

/** The crew as one line: each group's label, then its workers, `shown` of them per group. */
function crewLine(byGroup: Map<Group, CrewRow[]>, shown: Map<Group, number>, nowMs: number, isTimed: boolean, hidden: number): Line {
  const line: Line = []
  for (const group of GROUPS) {
    const rows = (byGroup.get(group) ?? []).slice(0, shown.get(group) ?? 0)
    if (rows.length === 0) continue
    if (line.length > 0) line.push(seg(GROUP_GAP, 'muted'))
    line.push(seg(GROUP_LABELS[group], group === 'stuck' ? 'warn' : 'head'), seg(GAP))
    rows.forEach((row, i) => {
      if (i > 0) line.push(seg(ITEM_SEP, 'muted'))
      line.push(...itemSegs(row, nowMs, isTimed))
    })
  }
  if (hidden > 0) line.push(seg(`${line.length > 0 ? GROUP_GAP : ''}+${hidden} more`, 'muted'))
  return line
}

const widthOf = (line: Line) => line.reduce((n, s) => n + s.text.length, 0)

/**
 * The band's second row: the crew in one line no wider than `width`. When it
 * is too long the times go first. Then workers are cut from the end of the
 * lowest group, down to one per group, and last whole groups from the end, so
 * the worst news is the last thing cut. What is cut is counted as "+N more".
 */
export function crewRow(view: FleetView, width: number, nowMs: number): Line {
  if (view.crewHealth === 'reading') return [seg('reading Herdr…', 'muted')]
  if (view.crewHealth === 'unreadable') return [seg("can't read Herdr", 'warn')]
  if (view.crew.length === 0) return [seg('No workers running', 'muted')]
  const byGroup = new Map<Group, CrewRow[]>(GROUPS.map(group => [group, view.crew.filter(row => row.group === group)]))
  const shown = new Map<Group, number>(GROUPS.map(group => [group, byGroup.get(group)!.length]))
  const total = view.crew.length
  const fits = (isTimed: boolean) => {
    const count = [...shown.values()].reduce((n, c) => n + c, 0)
    const line = crewLine(byGroup, shown, nowMs, isTimed, total - count)
    return widthOf(line) <= width ? line : null
  }
  const full = fits(true) ?? fits(false)
  if (full !== null) return full
  for (;;) {
    const trimmable = [...GROUPS].reverse().find(group => (shown.get(group) ?? 0) > 1)
    const last = [...GROUPS].reverse().find(group => (shown.get(group) ?? 0) > 0)
    const group = trimmable ?? last
    if (group === undefined) return [seg(`+${total} more`, 'muted')]
    shown.set(group, (shown.get(group) ?? 0) - 1)
    const line = fits(false)
    if (line !== null) return line
  }
}

/**
 * The band as lines. The first row leaves room for the button beside it
 * (`firstWidth`); the second may use the whole `width`.
 */
export function bandLines(view: FleetView, firstWidth: number, width: number, nowMs: number): Line[] {
  const first = packRow(needsSegs(view, firstWidth), firstWidth, GAP)
  if (view.health === 'not-configured') return first
  return [...first, crewRow(view, width, nowMs)]
}

/** The exceptions the status line carries: reads that failed, in the words of the failure. */
export function statusText(view: FleetView): string | undefined {
  if (view.health === 'not-configured') return undefined
  const failures: string[] = []
  if (view.summaryError !== null) {
    failures.push(`Firstmate summary ${view.health === 'unreadable' ? 'unreadable' : 'read failed'}: ${view.summaryError}`)
  }
  if (view.crewError !== null) failures.push(`Herdr read failed: ${view.crewError}`)
  return failures.length === 0 ? undefined : failures.join(' | ')
}
