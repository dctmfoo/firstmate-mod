// Toasts for changes in the joined view: something that newly needs the captain, a
// newly merged landing, a worker that newly got stuck, a provider entering the
// headroom threshold. Each kind's first sighting is a silent baseline, so history never
// replays on startup, after /clear or after a reload; a key toasts once.

import type { ToastLedger } from '../types'
import type { FleetView } from './fleet'
import { clip, harnessName } from './text'

export const SEEN_LIMIT = 600
export const TOASTS_PER_READ = 3

export type Candidate = { key: string; text: string }

export type ToastKind = 'needs' | 'landed' | 'stuck' | 'headroom'

export const EMPTY_LEDGER: ToastLedger = { baselined: [], seen: [] }

/** The candidates of one kind, or null while that kind's records are not trustworthy enough to baseline. */
export function candidatesOf(kind: ToastKind, view: FleetView, thresholdPercent: number): Candidate[] | null {
  switch (kind) {
    case 'needs':
      if (view.health !== 'ok') return null
      return view.needs.map(item =>
        item.kind === 'merge'
          ? { key: `merge:${item.url}`, text: `Firstmate: merge? ${clip(item.name, 50)} ${item.url}` }
          : { key: `call:${item.call.key}`, text: `Firstmate: needs you: ${clip(item.call.summary ?? item.call.key, 80)}` },
      )
    case 'landed':
      if (view.health !== 'ok') return null
      return view.landed
        .filter(item => item.verb === 'merged' && item.prUrl !== null)
        .map(item => ({
          key: `landed:${item.id}:${item.prUrl}`,
          text: `Firstmate: merged: ${clip(item.title ?? item.id, 70)} ${item.prUrl}`,
        }))
    case 'stuck':
      if (view.crewHealth !== 'ok') return null
      return view.crew
        .filter(row => row.group === 'stuck')
        .map(row => ({ key: `stuck:${row.id}:${row.why}`, text: `Firstmate: ${row.name} is stuck${row.why === null ? '' : `: ${row.why}`}` }))
    case 'headroom': {
      const quota = view.quota
      if (quota === null || thresholdPercent <= 0) return null
      return quota.providers.flatMap(p => {
        const all = p.effective.find(e => e.scope === 'all_models')
        const pct = all?.effectivePercentRemaining ?? null
        if (p.isStale === true || p.status !== 'fresh' || pct === null || pct > thresholdPercent) return []
        const windowId = all?.limitingWindowIds[0] ?? 'window'
        const window = p.windows.find(w => w.id === windowId)
        return [
          {
            // The hour of the reset names the window; its sub-second spelling moves between reads.
            key: `headroom:${p.provider}:${windowId}:${window?.resetsAt?.slice(0, 13) ?? ''}`,
            text: `Firstmate: ${harnessName(p.provider)} headroom ${pct}% (${window?.label ?? windowId} window)`,
          },
        ]
      })
    }
  }
}

/** Folds one kind's candidates into the ledger: what to toast now, and the ledger after. */
export function transition(
  ledger: ToastLedger,
  kind: ToastKind,
  candidates: Candidate[] | null,
): { ledger: ToastLedger; toasts: string[] } {
  if (candidates === null) return { ledger, toasts: [] }
  // A worker that got unstuck may get stuck again later: that is a new transition.
  const current = new Set(candidates.map(c => c.key))
  const kept = kind === 'stuck' ? ledger.seen.filter(key => !key.startsWith('stuck:') || current.has(key)) : ledger.seen
  const seen = new Set(kept)
  const fresh = candidates.filter(c => !seen.has(c.key))
  const isBaseline = !ledger.baselined.includes(kind)
  // Nothing new and nothing dropped: the same ledger, so the caller can skip writing it.
  if (!isBaseline && fresh.length === 0 && kept.length === ledger.seen.length) return { ledger, toasts: [] }
  const next: ToastLedger = {
    baselined: isBaseline ? [...ledger.baselined, kind] : ledger.baselined,
    seen: [...kept, ...fresh.map(c => c.key)].slice(-SEEN_LIMIT),
  }
  if (isBaseline || fresh.length === 0) return { ledger: next, toasts: [] }
  const shown = fresh.slice(0, TOASTS_PER_READ).map(c => c.text)
  if (fresh.length > TOASTS_PER_READ) shown.push(`Firstmate: ${fresh.length - TOASTS_PER_READ} more new; see /fm-fleet`)
  return { ledger: next, toasts: shown }
}

/** All kinds at once, in a fixed order. */
export function transitions(ledger: ToastLedger, view: FleetView, thresholdPercent: number, kinds: ToastKind[]) {
  let current = ledger
  const toasts: string[] = []
  for (const kind of kinds) {
    const step = transition(current, kind, candidatesOf(kind, view, thresholdPercent))
    current = step.ledger
    toasts.push(...step.toasts)
  }
  return { ledger: current, toasts }
}
