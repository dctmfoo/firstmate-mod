# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the shape.
- Preserve the [read-only boundary](README.md#what-it-reads). Changes that cross it will not be accepted.
- Keep the band to two quiet rows. New information usually belongs in the pane.

## Setup

You need [Claude Code](https://code.claude.com) with plugin mods and [Bun](https://bun.sh).

```sh
git clone https://github.com/dctmfoo/firstmate-mod.git
cd firstmate-mod
claude --plugin-dir . -p "hi" || true      # lays the engine's type declarations in .claude-plugin/types
```

## Checks

CI runs these on every pull request; run them before you push:

```sh
claude plugin validate --strict .
claude plugin test .
bunx --package typescript@5.9.3 tsc -p tsconfig.json
scripts/check-public.sh
```

To see the band and pane as text without Claude Code:

```sh
bun scripts/render-replay.ts "$PWD/fixtures/demo-home"
```

To try your change live, follow the README's [demo-home setup](README.md#try-it-without-firstmate).

## Tests and fixtures

- Tests live in `tests/` and run in Claude Code's plugin test kit, which has no file system.
- [`fixtures/demo-home`](fixtures/demo-home) is a made-up Firstmate home. `tests/fixtures/demo-home.ts` is generated from it:

  ```sh
  bun scripts/fixture-ts.mjs fixtures/demo-home tests/fixtures/demo-home.ts DEMO_HOME
  ```

  Edit the directory and regenerate; do not edit the generated file by hand.
- Add a test with every behavior change. Prefer the replay tests (`tests/band.test.ts`, `tests/pane.test.ts`, `tests/lifecycle.test.ts`) for anything a person sees.

## Keep personal data out

Keep committed data safe for public use. Never commit data from a real Firstmate home: project names, task ids, status lines, backlog rows, pull request links, paths or account details.

`scripts/capture-replay.sh` copies a real home for local debugging. Write its output under `.capture/` (ignored by git), and turn anything you want to keep into made-up data in `fixtures/demo-home` first. `scripts/check-public.sh` fails CI on local absolute paths in the tree, but it cannot recognize every private name, so check your diff.

## Pull requests

- One change per pull request, with a short description of what changed and why.
- Use [Conventional Commits](https://www.conventionalcommits.org) for titles (`fix(hooks): …`, `docs: …`).
- Update the README when behavior a user can see changes.
