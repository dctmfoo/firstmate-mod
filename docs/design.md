# Design notes

These notes cover why the band and pane look and behave as they do. The [README](../README.md) covers usage.

## What the band is for

The person running Firstmate works in its main Claude session and keeps talking to Firstmate. The band answers two questions without being asked:

- **Does anything need me?** Row 1: `Nothing needs you`, or what does, with a pull request's full link when a merge is waiting.
- **What is each worker doing, and for how long?** Row 2: every worker by plain name with its time in state, worst first (Stuck, Just finished, Working, Waiting).

An earlier band showed counts and health words (`Alive`, `Working 3 confirmed`, `Calls 4 recorded`, panes present, summary validity). It answered neither question, so it was replaced. The band no longer depends on Firstmate's typed records for everything: live activity comes from Herdr.

The pane gives the same content more room. Discuss leaves the decision with Firstmate: the person edits and sends the draft or clears it, and the mod never records an answer.

## Data shape

The [README](../README.md#what-it-reads) owns the read sources and failure behavior. [`types/index.d.ts`](../types/index.d.ts) owns the normalized record shapes.

The records are held in three lanes in `$.state` (summary, crew, headroom), each with its own cadence and its own last good value. One pure fold (`hooks/fleet.ts`) turns the lanes into the view both drawings use. The fold is a join and a sort; it grades nothing about the work itself.

### Why Herdr alone is not enough

Herdr is right about *activity* and wrong about *meaning*:

- `done` means a turn ended, not that the task finished. A worker running its own background tests shows `done`, and so does a worker waiting on another task.
- Herdr keeps no timestamps for any state.
- It knows no task identity or plain name, and cannot see the calls waiting on the person, open pull requests or merges.

So each worker's Herdr state is joined with its own newest status line. The [README](../README.md#how-worker-state-is-worked-out) owns the join and duration rules. Polling gives enough precision for durations shown in minutes; an event stream could cut detection delay but would not recover a state change that happened before the mod loaded.

### Read cost

The crew lane polls frequently, so it uses file mtimes to avoid rereading unchanged records and batches changed-file reads in parallel. The [README](../README.md#what-it-reads) owns the exact read rules. The toast ledger also retains its identity when no announcement changed, so the caller can skip rewriting it. [`hooks/toasts.ts`](../hooks/toasts.ts) owns that rule.

### Names

Backlog titles are long, so mechanical cuts can read poorly (`the 1.4 release branch is beh…`). The better fix is a 2 to 5 word name set as the Herdr tab label at spawn, joined through `herdr_tab_id`; that is a Firstmate change, and this mod does not need it to work.

## Alternatives considered

- **Roster band (one row per worker)** and **one row of counts plus the newest event.** The roster costs seven or more rows every turn; the one-row band brings counts back.
- **Scrape the screen for durations.** Rejected. Duration text varies by harness and version, and it would be a second classifier of worker state.
- **Make Firstmate publish liveness.** Unnecessary: Herdr already lists every pane.
- **Parse Firstmate's human-readable fleet views, or run its snapshot helpers.** Rejected. Prose is for people, and some helpers refresh cached files under `state/`, which breaks the read-only boundary.
- **Read forge state directly (`gh`).** Rejected. Firstmate owns observation, freshness and verdicts for pull requests; its summary lists the ones that are the person's to merge.

## Tradeoffs

- **Freshness against cost.** Detection delay depends on the configured crew interval and read duration; a failed read keeps older state.
- **Times are approximate.** Herdr supplies no state timestamps, so the first-sighting seed can overestimate or underestimate time in state. Later transitions are timed when a read observes them.
- **Stuck is an inference.** "Stopped without a word" follows a quiet pane with a working or missing status line after the grace period. Background work can make this inference wrong.
- **Read-only.** The mod calls no write API; `tests/lifecycle.test.ts` asserts that nothing is written and that the only commands run are `herdr agent list` and the quota command.
- **Docking is the host's decision.** The pane asks for 72 docked columns; a width the person drags wins, and narrow terminals open it inline.

## Follow-ups

- A short name per task as the Herdr tab label (a Firstmate change), so the band stops cutting backlog titles.
- A completion timestamp on landings, so "just finished" can be timed after a worker's status file is gone. Landing records carry only a date today.
- A typed wait reason on `paused:` lines, so Waiting rows can say why in plain words.
- Secondmate homes and cross-home totals. These need a read-only fleet projection that writes nothing.
