# omp-worktree-guard

An [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) plugin that enforces the **git worktree isolation policy** structurally: agent file edits (`edit` / `write` tools) never land in the main checkout of a git repository.

Every change is built in a linked worktree and merged back with `git merge` — a metadata operation the guard leaves to `bash`.

## Why

Prose policy in `AGENTS.md`/skills is advisory; models skip it on small tasks. A pre-tool-call hook makes the policy structural: the refused `edit` returns an actionable reason ("build in `.worktrees/<feature>`, merge from the main checkout") and the agent self-corrects on the spot.

## How it decides

Attribution is **per-target**: for each `edit`/`write` target the guard walks up from the target's own path.

| Nearest `.git` | Meaning | Verdict |
| --- | --- | --- |
| directory | main checkout | **block** unless target is under that root's `.worktrees/` |
| file | linked worktree | **allow** |
| none | not a repo | allow (fail open) |

Because there is no cwd or hook-location anchor, the same hook file works repo-local (`.omp/hooks/pre/`), user-level (`~/.omp/agent/hooks/pre/`), and plugin-hosted (`hooks/pre/` in this package), and sessions started outside any repo still cannot edit a repo's main checkout via absolute paths.

## Install

```sh
omp plugin install github:Daviey/omp-worktree-guard
```

or for local development:

```sh
git clone https://github.com/Daviey/omp-worktree-guard.git
omp plugin link ~/dev/worktree-guard-plugin
```

## Behavior details

- **Guarded tools**: `edit`, `write`. `bash` is deliberately unguarded so `git merge`/`push`/`rebase` still run in the main checkout.
- **Edit payloads**: every `[PATH#TAG]` / `[PATH]` section header and `MV DEST` line is extracted and judged.
- **Write paths**: optional copied `[path#TAG]` wrappers are stripped first.
- **Archive/SQLite selectors** (`x.zip:inner`, `db.sqlite:table`): the container file is judged.
- **Fail open**: unknown input shapes, unattributable locations (internal `xd://`-style URLs, `~`-relative paths) and internal errors allow the call. A guard bug must not brick every edit session.
- **Sanctioned areas**: `<repo>/.worktrees/<anything>` in-repo sandbox; linked worktrees anywhere (their `.git` is a file); sibling `../<repo>-<feature>` layouts (outside the guarded root entirely).

## Known bypasses (accepted)

`bash`-file-writes (`sed`/`tee`), `conflict://` writes, `lsp rename_file`, `xd://ast_edit` device dispatch. This is a guardrail, not a jail.

## Prior art / adjacent

- [ShakhzodbekBabakulov/worktree-guard](https://github.com/ShakhzodbekBabakulov/worktree-guard) — Claude Code `/work`→`/done` slash-command workflow (no blocking guard).
- [Pfgoriaux/pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) — concurrent pi session claim-mutex blocking `git stash`/`checkout` (different failure mode).
- [earneet/worktree-guard](https://github.com/earneet/worktree-guard) — Kimi Code plugin with PreToolUse hook, per-repo coexistence yield, and worktree lifecycle scripts.

## License

MIT
