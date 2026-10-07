# Security policy

## Supported versions

Only the latest release on `main` gets fixes.

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/dctmfoo/firstmate-mod/security/advisories/new). Do not open a public issue for them.

Include what you found, how to reproduce it, and what it could let someone do. Expect a first reply within a week.

## What counts

The mod is meant to be read-only. These are in scope:

- Anything that makes the mod write, delete or change a file, or run a command other than the configured `herdr_command` and `quota_command`.
- A path built from untrusted record content that reads outside the configured Firstmate home.
- Record content that ends up submitted as a prompt without the person pressing Enter.

Problems in Claude Code, Firstmate, Herdr or quota-axi themselves belong to those projects.
