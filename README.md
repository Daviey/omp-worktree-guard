# omp-worktree-guard

An [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) plugin that enforces the **git worktree isolation policy** structurally: agent file edits (`edit` / `write` tools) never land in the main checkout of a git repository.

Every change is built in a linked worktree and merged back with `git merge` — a metadata operation the guard leaves to `bash`.

## Why

Prose policy in `AGENTS.md`/skills is advisory; models skip it on small tasks. A pre-tool-call hook makes the policy structural: the refused `edit` returns an actionable reason ("build in `.worktrees/<feature>`, merge from the main checkout") and the agent self-corrects on the spot.

## How it decides

Attribution is **per-target**: for each `edit`/`write` target the guard walks up from the target's own path.

| Nearest `.git` | Meaning | Verdict |
| --- | --- | --- |
| directory | main checkout | **block** unless target is under a sanctioned sandbox dir |
| file | linked worktree | **allow** |
| none | not a repo | allow (fail open) |

Because there is no cwd or hook-location anchor, the same hook file works repo-local (`.omp/hooks/pre/`), user-level (`~/.omp/agent/hooks/pre/`), and plugin-hosted (`hooks/pre/` in this package), and sessions started outside any repo still cannot edit a repo's main checkout via absolute paths.

## Install

```sh
omp plugin install github:Daviey/omp-worktree-guard
```

Tag-pinned installs (`#vX.Y.Z` suffix on the same spec — pinned installs never
auto-update) are documented in the repo README's Install section.

or for local development:

```sh
git clone https://github.com/Daviey/omp-worktree-guard.git
omp plugin link <path-to-clone>
```

## What's in the package

| Piece | What it does |
| --- | --- |
| `hooks/pre/worktree-guard.ts` | The guard — blocks `edit`/`write` on main checkouts |
| `skills/worktree-isolation` | Auto-loaded skill teaching agents the sanctioned workflow (create → build → merge → clean) |
| `/wt` command | Slash command automating it: `/wt <feature>`, `/wt merge <feature>`, `/wt list`, `/wt clean` |

Optional features (disable with `omp plugin config omp-worktree-guard --disable-feature wt-command` etc.): `wt-command` (the `/wt` slash command), `worktree-skill` (the skill).

## Per-repo configuration

Drop `.omp/worktree-guard.json` in a repo root:

```json
{
  "sandboxDirs": [".worktrees", "sand"],
  "strict": false
}
```

- `sandboxDirs` — directories under the repo root that count as sanctioned sandboxes (default `[".worktrees"]`). `".worktrees"` inside the list keeps the default alongside customs; overriding the array replaces defaults entirely. Linked worktrees are ALWAYS sanctioned regardless (their `.git` is a file) — including sibling layouts outside the root.
- `strict` — `true` blocks edits anywhere inside the repo root (even plain non-worktree dirs under sandbox names; actual linked worktrees remain allowed). For teams that want work strictly OUTSIDE the repo directory. Default `false`.

Missing or malformed config falls back to defaults — never throws.

## Behavior details

- **Guarded tools**: `edit`, `write`. `bash` is deliberately unguarded so `git merge`/`push`/`rebase` still run in the main checkout.
- **Edit payloads**: every `[PATH#TAG]` / `[PATH]` section header and `MV DEST` line is extracted and judged.
- **Write paths**: optional copied `[path#TAG]` wrappers are stripped first.
- **Archive/SQLite selectors** (`x.zip:inner`, `db.sqlite:table`): the container file is judged.
- **Fail open**: unknown input shapes, unattributable locations (internal `xd://`-style URLs, `~`-relative paths) and internal errors allow the call. A guard bug must not brick every edit session.
- **Sanctioned areas**: configured sandbox dirs under the root; linked worktrees anywhere (their `.git` is a file).

## Known bypasses (accepted)

`bash`-file-writes (`sed`/`tee`), `conflict://` writes, `lsp rename_file`, `xd://ast_edit` device dispatch. This is a guardrail, not a jail.

## Development

```sh
bun test hooks/pre/    # unit tests (real temp-dir git repos)
```

## Prior art / adjacent

- [ShakhzodbekBabakulov/worktree-guard](https://github.com/ShakhzodbekBabakulov/worktree-guard) — Claude Code `/work`→`/done` slash-command workflow (no blocking guard).
- [earneet/worktree-guard](https://github.com/earneet/worktree-guard) — Kimi Code plugin with PreToolUse hook, per-repo coexistence yield, and worktree lifecycle scripts.
- [Pfgoriaux/pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) — concurrent pi session claim-mutex blocking `git stash`/`checkout` (different failure mode).

## License

MIT
