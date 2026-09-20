---
name: worktree-isolation
description: Build every file change in a linked git worktree and merge back — use when a worktree policy blocks your edit, or before starting any multi-file change in a git repo
---

# Worktree isolation workflow

The main checkout of a git repo is never edited directly by you. Every change — however small — is built in a linked worktree and merged back. If an `edit`/`write` call is refused with a "worktree policy" error, this is why; follow the steps below.

## Starting work

1. From the repo root, create the worktree (branch name = feature name):
   ```sh
   git worktree add .worktrees/<feature> -b <feature>
   ```
   If the repo prefers siblings, `git worktree add ../<repo>-<feature> -b <feature>` instead — check what already exists (`git worktree list`).
2. Copy any gitignored files the build needs (e.g. `.env`) — untracked files do not propagate to worktrees.
3. Do all file edits inside the worktree. Every build/test command needs an explicit cwd — the session shell does not follow you.

## Merging back

1. Commit your work in the worktree.
2. From the MAIN checkout (git metadata operations are allowed there):
   ```sh
   git merge <feature> --no-edit
   ```
   Expect divergence — the user keeps committing; resolve conflicts normally.
3. Re-run the build/test suite in the MAIN checkout after merging — auto-merge is textual.
4. Clean up: `git worktree remove .worktrees/<feature>` (branch survives).

## Traps

- Un-ignored `.worktrees/` corrupts `git add -A` (nested worktree becomes a gitlink entry). Keep it ignored.
- Relative paths resolve against your session cwd, not the worktree — prefer absolute paths for edits.
- `git merge --ff-only` often fails on diverged mains; plain merge is normal.
