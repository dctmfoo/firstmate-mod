// Terminal text: segments with a tone, packed into rows that fit a width.
// The tones map to the terminal's own ANSI palette at draw time, and every
// qualifier is a word, so nothing depends on color alone.

export type Tone = 'brand' | 'head' | 'plain' | 'muted' | 'warn'

export type Seg = {
  text: string
  tone: Tone
  /** A shorter spelling for narrow widths; the qualifier words stay. */
  short?: string
}

export type Line = Seg[]

export const seg = (text: string, tone: Tone = 'plain', short?: string): Seg =>
  short === undefined ? { text, tone } : { text, tone, short }

const widthOf = (segs: Seg[], sep: string, isShort: boolean) =>
  segs.reduce((n, s, i) => n + (i === 0 ? 0 : sep.length) + (isShort ? (s.short ?? s.text) : s.text).length, 0)

/**
 * Packs one logical row's segments into lines no wider than `width`: the full
 * spelling when the row fits, else the short spelling, then wrapping between
 * segments. A segment longer than the width keeps its own line and wraps there.
 */
export function packRow(segs: Seg[], width: number, sep: string, sepTone: Tone = 'muted'): Line[] {
  if (segs.length === 0) return []
  const isShort = widthOf(segs, sep, false) > width
  const lines: Line[] = []
  let line: Line = []
  let used = 0
  for (const s of segs) {
    const text = isShort ? (s.short ?? s.text) : s.text
    const piece: Seg = { text, tone: s.tone }
    const need = line.length === 0 ? text.length : sep.length + text.length
    if (line.length > 0 && used + need > width) {
      lines.push(line)
      line = []
      used = 0
    }
    if (line.length > 0) {
      line.push({ text: sep, tone: sepTone })
      used += sep.length
    }
    line.push(piece)
    used += text.length
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/**
 * How long something has lasted, in the plain units a glance needs: under a
 * minute reads `<1m`, then `12m`, `3h`, `2d`. Minutes are the finest grain
 * because the reads that stamp the time run every few seconds.
 */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A number of days the way a person says it: `today`, `1 day`, `10 days`. */
export function daysText(days: number): string {
  if (days < 1) return 'today'
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** A harness id as people say it: codex as Codex. */
export function harnessName(harness: string | null): string {
  if (harness === null || harness === '') return 'unknown harness'
  return harness.charAt(0).toUpperCase() + harness.slice(1)
}

/** Cuts text to `width` with an ellipsis, for a one-row caption. */
export function clip(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/**
 * A full URL or path as rows no wider than `width`, broken after a `/` where
 * one fits so each piece stays readable; never shortened.
 */
export function pathRows(text: string, width: number): string[] {
  if (text.length <= width || width < 8) return [text]
  const rows: string[] = []
  let rest = text
  while (rest.length > width) {
    const cut = rest.lastIndexOf('/', width - 1)
    const at = cut > width / 3 ? cut + 1 : width
    rows.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest !== '') rows.push(rest)
  return rows
}
