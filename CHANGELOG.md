# Changelog

## 0.3.0

- Public release: MIT license, contributing guide, security policy, issue and pull request templates.
- Crew polling reduces filesystem calls and batches changed-file reads; see the [read rules](README.md#what-it-reads).
- A worker relaunched into a new Herdr tab is followed (its metadata is read again when it changes).
- Worker names refresh when the backlog changes.
- A read that changes nothing no longer rewrites the toast ledger; a refused status line or toast no longer breaks a lane.
- Tests and docs use a made-up demo home; `scripts/demo-home.ts` makes a live copy for trying the plugin without Firstmate.

## 0.2.0

- Band design "You / Crew": row 1 says what needs you, row 2 names every worker by state from live Herdr data.
- Merge asks that Firstmate's own records show settled leave Needs you at the next summary read.
- CI: plugin validation, tests and type-check on every pull request.

## 0.1.0

- First version: the band above the prompt, the `/fm-fleet` pane, `/fm-refresh`, toasts and Discuss.
