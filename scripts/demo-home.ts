#!/usr/bin/env bun
// demo-home.ts - copy fixtures/demo-home to <out-dir> with its clock moved to now.
//
// Usage: bun scripts/demo-home.ts <out-dir>
//
// The demo home is made-up data frozen at one moment, so in a live session its
// workers would read as days old and its landings as long gone. This copy
// shifts every status line's [at=…] and the summary's generated time together,
// then shifts landing dates by whole days so the newest is today locally.
// Point the mod's `home` at <out-dir>, `herdr_command` at
// <out-dir>/bin/herdr and `quota_command` at <out-dir>/bin/quota-axi.

import { chmodSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (out === undefined) {
  console.error('usage: demo-home.ts <out-dir>')
  process.exit(2)
}

const source = join(import.meta.dir, '..', 'fixtures', 'demo-home')
cpSync(source, out, { recursive: true })

const capture = JSON.parse(readFileSync(join(out, 'capture.json'), 'utf8')) as { started: string; ended: string }
const nowMs = Date.now()
const shiftS = Math.floor((nowMs - Date.parse(capture.ended)) / 1000)

const two = (n: number) => String(n).padStart(2, '0')
const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
// Landing dates move by whole days, so the newest is today in this machine's time zone.
const dayMs = (day: string) => Date.parse(`${day}T12:00:00`)

const state = join(out, 'state')
for (const name of readdirSync(state)) {
  if (!name.endsWith('.status')) continue
  const path = join(state, name)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\[at=(\d+)\]/g, (_, at: string) => `[at=${Number(at) + shiftS}]`))
}

const summaryPath = join(state, 'home-summary.json')
const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
  generated: string
  generated_epoch: number
  landed: { completion: { date: string } }[]
}
summary.generated_epoch += shiftS
summary.generated = new Date(summary.generated_epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const newest = summary.landed.map(l => l.completion.date).sort().at(-1)
if (newest !== undefined) {
  const shiftDays = Math.round((dayMs(localDay(nowMs)) - dayMs(newest)) / 86_400_000)
  for (const landed of summary.landed) landed.completion.date = localDay(dayMs(landed.completion.date) + shiftDays * 86_400_000)
}
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

capture.started = new Date(Date.parse(capture.started) + shiftS * 1000).toISOString()
capture.ended = new Date(nowMs).toISOString()
writeFileSync(join(out, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`)

for (const stub of ['herdr', 'quota-axi']) chmodSync(join(out, 'bin', stub), 0o755)
console.log(`demo home at ${out}, clock moved ${shiftS}s to now`)
