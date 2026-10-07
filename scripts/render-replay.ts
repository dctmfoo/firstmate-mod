#!/usr/bin/env bun
// render-replay.ts - print the band and the pane for a home, outside Claude Code.
//
// Usage: bun scripts/render-replay.ts <home> [--width 160] [--pane 72] [--plain]
//
// Runs the mod's own read adapter and layout over <home> and prints ANSI text,
// a preview of the layout rather than a capture of the engine's paint.
// Homes with capture.json, including fixtures/demo-home, use their stand-in
// commands and recorded clock; real homes use the live commands and clock.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'

import { bandLines } from '../hooks/band'
import { fleetViewOf } from '../hooks/fleet'
import { paneItems } from '../hooks/pane'
import { newCrewCache, readCrew, readHome, readQuota, type Host } from '../hooks/sources'
import type { Line, Tone } from '../hooks/text'

const args = process.argv.slice(2)
const home = args[0]
if (home === undefined) {
  console.error('usage: render-replay.ts <home> [--width N] [--pane N] [--plain]')
  process.exit(2)
}
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const width = Number(flag('--width', '160'))
const paneWidth = Number(flag('--pane', '72'))
const isPlain = args.includes('--plain')
const isReplay = statSync(`${home}/capture.json`, { throwIfNoEntry: false }) !== undefined

const host: Host = {
  read: async path => readFileSync(path, 'utf8'),
  list: async path =>
    readdirSync(path, { withFileTypes: true }).map(d => ({
      name: d.name,
      kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
      size: 0,
      mtimeMs: 0,
      isLink: d.isSymbolicLink(),
    })),
  mtime: async path => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? null,
  run: async (argv, init) => {
    const [command, ...rest] = argv
    const resolved = isReplay && (command === 'quota-axi' || command === 'herdr') ? `${home}/bin/${command}` : command!
    try {
      const stdout = execFileSync(resolved, rest, {
        cwd: init?.cwd,
        env: { ...process.env, ...init?.env },
        timeout: init?.timeoutMs,
        encoding: 'utf8',
      })
      return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
    }
  },
  now: async () => Date.now(),
}

const capture = isReplay ? JSON.parse(readFileSync(`${home}/capture.json`, 'utf8')) : null
const nowMs = capture?.ended ? Date.parse(capture.ended) : Date.now()

const lane = <T>(value: T, at: number) => ({ value, readAt: at, error: null })
const failed = (error: unknown, at: number) => ({ value: null, readAt: null, error: { reason: String((error as Error).message ?? error), at } })
const records = await readHome(host, home)
const crew = await readCrew(host, home, 'herdr', newCrewCache(), null, nowMs).then(value => lane(value, nowMs), error => failed(error, nowMs))
const quota = await readQuota(host, 'quota-axi', home).then(value => lane(value, nowMs), error => failed(error, nowMs))
const view = fleetViewOf(home, { home: lane(records, nowMs), crew, quota }, nowMs)

const SGR: Record<Tone, string> = { brand: '\x1b[1;32m', head: '\x1b[32m', plain: '', muted: '\x1b[2m', warn: '\x1b[33m' }
const paint = (line: Line) => line.map(s => (isPlain || SGR[s.tone] === '' ? s.text : `${SGR[s.tone]}${s.text}\x1b[0m`)).join('')
const rule = (n: number) => (isPlain ? '─'.repeat(n) : `\x1b[2;32m${'─'.repeat(n)}\x1b[0m`)

console.log(rule(width))
bandLines(view, width - 12, width, nowMs).forEach((line, i) => console.log(paint(line) + (i === 0 ? (isPlain ? '  /fm-fleet' : '\x1b[2m  /fm-fleet\x1b[0m') : '')))
console.log('> ')
console.log('')
console.log(isPlain ? `┌${'─'.repeat(paneWidth + 2)}┐` : `\x1b[2m┌${'─'.repeat(paneWidth + 2)}┐\x1b[0m`)
for (const item of paneItems(view, paneWidth, nowMs)) {
  const text =
    item.kind === 'line'
      ? ' '.repeat(item.indent ?? 0) + paint(item.line)
      : item.kind === 'gap'
        ? ''
        : item.kind === 'header'
          ? 'FIRSTMATE  r: refresh  Esc closes'
          : '  [ Discuss with Firstmate ]'
  console.log(`  ${text}`)
}
console.log(isPlain ? `└${'─'.repeat(paneWidth + 2)}┘` : `\x1b[2m└${'─'.repeat(paneWidth + 2)}┘\x1b[0m`)
