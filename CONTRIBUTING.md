# Contributing to lcr

Thanks for helping out! Bug reports, ideas, docs fixes and PRs are all welcome.

## Before you start

- **Bugs / small fixes**: just open a PR (or an issue if you're not sure how to fix it).
- **New features or bigger changes**: please open an issue first so we can agree on the approach before you spend time on it.
- Looking for something to do? Check issues labeled [`good first issue`](../../labels/good%20first%20issue) and [`help wanted`](../../labels/help%20wanted).

## Setup

Requires [Bun](https://bun.sh) and git (tmux is optional, needed only for the "send to Claude pane" flow).

```sh
git clone https://github.com/viniciusteixeiradias/local-code-review.git
cd local-code-review
bun install        # also builds the UI into ui/dist
bun link           # optional: puts `lcr` on your PATH
```

## Development loop

```sh
LCR_DEV_ORIGIN=http://localhost:5173 lcr --no-open --port 4747   # API server (terminal 1)
bun run dev:ui                                                  # Vite + HMR on :5173, proxies to :4747 (terminal 2)
```

Run `lcr` inside any git repo with changes to try it against real diffs.

The server only accepts requests from its own page, so other websites can't read your code or drive it (see `src/guard.ts`). `LCR_DEV_ORIGIN` lets the Vite dev page through as well. Only use it while developing.

## Project layout

| Path | What lives there |
|------|------------------|
| `bin/lcr` | CLI entry point |
| `src/cli.ts` | Argument parsing and subcommands (`feedback`, `resolve`, `reply`, …) |
| `src/server.ts` | HTTP server + live updates for the UI |
| `src/guard.ts` | Rejects requests that don't come from lcr's own page |
| `src/git.ts`, `src/diff.ts` | Running git and parsing diffs |
| `src/store.ts` | Review/comment state in `.git/lcr/reviews/<branch>.json` |
| `src/anchor.ts` | Re-anchoring comments when lines move |
| `src/tmux.ts`, `src/prompt.ts` | Detecting Claude panes and building the prompt sent to them |
| `ui/` | Vue 3 app, built with Vite |
| `test/` | `bun test` suites |
| `claude/commands/` | Optional Claude Code slash command |

Note: `ui/` is not a standalone Vue project. It has no `package.json` of its own: its dependencies live in the root `package.json`, and Vite runs from the repo root via `--config ui/vite.config.ts`. The CLI serves the built `ui/dist/`, which `bun install` builds for you through `postinstall`.

## Before opening a PR

```sh
bun test
bun run typecheck
```

CI runs both on every PR. Please also:

- Keep PRs focused: one fix or feature per PR.
- Add or update tests in `test/` for behavior changes in `src/`.
- Update `README.md` if you change CLI flags, commands or keyboard shortcuts.
- For UI changes, include a screenshot or short GIF in the PR description.

## Commit messages

No strict convention. Use a short imperative summary line ("Fix outdated flag on renamed files"), with more detail in the body if needed.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
