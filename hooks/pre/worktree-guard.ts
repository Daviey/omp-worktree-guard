// omp-worktree-guard — pre-tool-call guard enforcing git-worktree isolation.
//
// Policy: agent file edits (edit/write tools) never land in the main checkout
// of a git repository. Every change is built in a linked worktree
//   <repo>/.worktrees/<feature>   (in-repo sandbox, sanctioned)
//   ../<repo>-<feature>           (sibling layout, outside the root)
// and merged back with `git merge <branch>` (a metadata operation, allowed
// by this guard because it does not go through edit/write).
//
// Attribution is PER-TARGET, never cwd- or hook-location-anchored: for each
// edit/write target we walk up from the target's own path. The nearest
//   .git directory  → main checkout → block unless the target sits under
//                      that root's .worktrees/ sandbox
//   .git file       → linked worktree → allow
//   no .git at all  → not a repo → fail open (allow)
// So the identical file works repo-local (.omp/hooks/pre/), user-level
// (~/.omp/agent/hooks/pre/), and plugin-hosted (hooks/pre/ in an omp
// plugin package) — no anchor choice, no per-repo copies, and sessions
// started outside any repo still cannot edit a repo's main checkout via
// absolute paths.
//
// Guarded tools: edit, write. bash is deliberately unguarded so git
// merge/push/rebase still run in the main checkout.
//
// This guard FAILS OPEN: unknown input shapes, unattributable locations
// and internal errors allow the call through. A guard bug must not brick
// every edit/write session; worst case is a missed policy hit. Known
// bypasses (accepted): bash-file-writes (sed/tee), conflict:// writes,
// lsp rename_file, xd://ast_edit device dispatch.
//
// Works on omp v18+ (HookAPI from @oh-my-pi/pi-coding-agent/extensibility/hooks).

import { readFileSync, statSync } from "node:fs";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const BLOCKED_TOOLS: Record<string, true> = { edit: true, write: true };

/** Lexically normalize an absolute POSIX path (collapse //, . and ..). */
function normalizeAbs(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/** Tolerant filesystem probe shared by every stat in the root walk:
 * missing/unreadable paths read as undefined, never throw. */
function statKind(p: string): "dir" | "file" | undefined {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Main-checkout root for an edit/write target, or undefined when the target
 * is not inside a git repo (fail open). Walk up from the target path: a
 * `.git` DIRECTORY marks a main checkout; a `.git` FILE is a linked-worktree
 * pointer, which means the target itself is sanctioned — signalled by
 * returning undefined so the caller allows it. Pointer targets are not
 * further resolved (resolution adds nothing: even if it led back to a main
 * checkout, the edit lands in the worktree copy, not the main tree).
 */
function repoRootForTarget(absTarget: string): string | undefined {
  let dir = absTarget.replace(/\/+$/, "");
  for (;;) {
    const dotGit = dir + "/.git";
    const kind = statKind(dotGit);
    if (kind === "dir") return dir;
    if (kind === "file") return undefined; // linked worktree — sanctioned
    const cut = dir.lastIndexOf("/");
    if (cut <= 0) return undefined;
    dir = dir.slice(0, cut);
  }
}

/** Runtime-narrowed string field read — no unchecked casts, tolerant of any
 * input shape the hook API hands us (fail-open on absence). */
function fieldString(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== "object" || !(key in obj)) return undefined;
  const v = Reflect.get(obj, key);
  return typeof v === "string" ? v : undefined;
}

/** Lexically resolve a tool path against cwd. Returns undefined when the
 * target is not a judgeable filesystem path (internal URLs, ~-relative). */
function resolveTarget(cwd: string, p: string): string | undefined {
  if (p.includes("://")) return undefined; // xd:// local:// memory:// ...
  if (p.startsWith("~")) return undefined; // home-relative, outside this policy
  const base = p.startsWith("/") ? p : cwd.replace(/\/+$/, "") + "/" + p;
  return normalizeAbs(base);
}

/** True when an absolute path is inside a guarded main checkout but outside
 * the sanctioned .worktrees/ sandbox. Sibling worktrees are outside the
 * guarded root entirely and therefore never guarded. Archive/SQLite
 * selectors ("x.zip:inner", "db.sqlite:table") keep their base path inside
 * the guard because the container file itself is the mutation. */
function inGuardedArea(abs: string, root: string): boolean {
  if (abs !== root && !abs.startsWith(root + "/")) return false;
  return !abs.startsWith(root + "/.worktrees/");
}

/** Extract every filesystem target from an edit tool `input` payload:
 * [PATH#TAG] / [PATH] section headers and MV DEST move lines. */
function editTargets(input: string): string[] {
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  const section = /^\[([^\]\n]+?)(?:#[0-9A-Fa-f]{1,8})?\]/gm;
  while ((m = section.exec(input))) targets.push(m[1]);
  const mv = /^MV[ \t]+["']?([^"'\n]+)["']?[ \t]*$/gm;
  while ((m = mv.exec(input))) targets.push(m[1]);
  return targets;
}

export default function worktreeGuard(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const tool = fieldString(event, "toolName") ?? "";
      if (!BLOCKED_TOOLS[tool]) return;

      const cwd =
        fieldString(ctx, "cwd") ||
        (typeof process !== "undefined" && process.cwd ? process.cwd() : "");

      const raw: string[] = [];
      const input = Reflect.get(event, "input");

      if (tool === "write") {
        const p = fieldString(input, "path");
        if (p !== undefined) {
          // strip an optional copied [path#TAG] wrapper from a write path
          const w = /^\[([^\]\n]+?)\]/.exec(p);
          raw.push(w ? w[1] : p);
        }
      } else {
        const s = fieldString(input, "input");
        if (s !== undefined) raw.push(...editTargets(s));
      }

      for (const r of raw) {
        const abs = resolveTarget(cwd, r);
        if (abs === undefined) continue;
        const root = repoRootForTarget(abs);
        if (root !== undefined && inGuardedArea(abs, root)) {
          return {
            block: true,
            reason:
              "worktree policy: file edits never land in the direct checkout " +
              root +
              ". Build the change in a linked worktree (.worktrees/<feature> in-repo, or a sibling " +
              "worktree), commit there, then `git merge <branch>` from the main checkout " +
              "(metadata only; bash is allowed there). Refused target: " +
              r,
          };
        }
      }
      return; // nothing judgeable, or all targets sanctioned
    } catch {
      return; // fail open — never brick edit/write on a guard bug
    }
  });
}
