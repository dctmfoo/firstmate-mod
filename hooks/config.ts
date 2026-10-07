// The mod's options, read once per load from its userConfig values.

import type { PluginOptions } from 'claude-code'

export type Config = {
  /** The one configured Firstmate home, absolute with no trailing slash; null when unset or relative. */
  home: string | null
  quotaCommand: string
  herdrCommand: string
  herdrMs: number
  summaryMs: number
  headroomMs: number
  headroomToastPercent: number
}

const numberOption = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

const commandOption = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

export function configOf(options: PluginOptions): Config {
  const rawHome = typeof options.home === 'string' ? options.home.trim() : ''
  const home = rawHome.startsWith('/') ? rawHome.replace(/\/+$/, '') || '/' : null
  return {
    home,
    quotaCommand: commandOption(options.quota_command, 'quota-axi'),
    herdrCommand: commandOption(options.herdr_command, 'herdr'),
    herdrMs: numberOption(options.herdr_seconds, 5, 2, 60) * 1000,
    summaryMs: numberOption(options.summary_seconds, 30, 5, 600) * 1000,
    headroomMs: numberOption(options.headroom_seconds, 900, 60, 3600) * 1000,
    headroomToastPercent: numberOption(options.headroom_toast_percent, 10, 0, 100),
  }
}
