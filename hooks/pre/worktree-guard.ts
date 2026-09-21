// omp-worktree-guard — pre-tool-call guard enforcing git-worktree isolation.
//
// Policy: agent file edits (edit/write tools) never land in the main checkout
// of a git repository. Every change is built in a linked worktree
//   <repo>/.worktrees/<feature>   (in-repo sandbox, sanctioned by default)
//   ../<repo>-<feature>           (sibling layout, outside the root)
// and merged back with `git merge <branch>` (a metadata operation, allowed
// by this guard because it does not go through edit/write).
//
// Attribution is PER-TARGET, never cwd- or hook-location-anchored: for each
// edit/write target we walk up from the target's own path. The nearest
//   .git directory  → main checkout → block unless the target sits under one
//                      of the root's sanctioned sandbox directories
//   .git file       → linked worktree → allow
//   no .git at all  → not a repo → fail open (allow)
// So the identical file works repo-local (.omp/hooks/pre/), user-level
// (~/.omp/agent/hooks/pre/), and plugin-hosted (hooks/pre/ in an omp
// plugin package) — no anchor choice, no per-repo copies, and sessions
// started outside any repo still cannot edit a repo's main checkout via
// absolute paths.
//
// Per-repo configuration (all optional): <repoRoot>/.omp/worktree-guard.json
//   { "sandboxDirs": [".."|"<dir>", ...],   // dirs (relative to repo root,
//                                            // ".." = sibling pattern) that
//                                            // count as sanctioned sandboxes.
//                                            // Default [".worktrees"]
//     "strict": true|false }                // false (default): fail open on
//                                            // errors/unknown shapes;
//                                            // true: block edits inside a
//                                            // known main checkout even when
//                                            // attribution is uncertain.
//
// Guarded tools: edit, write. bash is deliberately unguarded so git
// merge/push/rebase still run in the main checkout.
//
// This guard FAILS OPEN by default: unknown input shapes, unattributable
// locations and internal errors allow the call through. A guard bug must
// not brick every edit/write session; worst case is a missed policy hit.
// Known bypasses (accepted): bash-file-writes (sed/tee), conflict://
// writes, lsp rename_file, xd://ast_edit device dispatch.
//
// Works on omp v18+ (HookAPI from @oh-my-pi/pi-coding-agent/extensibility/hooks).

import { readFileSync, statSync } from "node:fs";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const BLOCKED_TOOLS: Record<string, true> = { edit: true, write: true };
const DEFAULT_SANDBOX_DIRS = [".worktrees"];

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
  if (p.includes("://")) return undefined; // xd:// '/home/dave/.omp/agent/sessions/-dev-llm-proxy/2026-09-20T15-53-16-136Z_01a0bf85-8e68-76d4-a333-8e5c90358457/local' memory:// ...
  if (p.startsWith("~")) return undefined; // home-relative, outside this policy
  const base = p.startsWith("/") ? p : cwd.replace(/\/+$/, "") + "/" + p;
  return normalizeAbs(base);
}

/**
 * Sandbox root when the SESSION itself runs inside an isolation sandbox,
 * undefined when it runs in (or above) a plain main checkout.
 *
 * Two shapes count:
 *  1. CWD under the omp isolation base (~/.omp/wt, or $OMP_WORKTREE_DIR /
 *     settings override) — the PAL's ZFS clones / overlays / rcopy mounts
 *     materialise at <base>/t<digest>/m. No .git needed: zfs clones carry
 *     the repo copy without a .git dir at the mount root.
 *  2. CWD's repo root is a linked git worktree (walk-up hits a `.git` FILE).
 *
 * Scoped exemption: targets outside the sandbox root still go through the
 * normal per-target attribution, so absolute-path escapes to the real main
 * checkout keep blocking.
 */
function isolatedSessionRoot(cwd: string): string | undefined {
  if (cwd.length === 0) return undefined;
  const base = isolationBaseDir();
  const normCwd = normalizeAbs(cwd);
  const normBase = normalizeAbs(base);
  if (normCwd === normBase || normCwd.startsWith(normBase + "/")) return normCwd;
  // Linked-worktree session: repoRootForTarget returns undefined for a
  // `.git`-file root, but we need the root itself to scope the exemption.
  let dir = normCwd;
  for (;;) {
    const dotGit = dir + "/.git";
    const kind = statKind(dotGit);
    if (kind === "file") return dir; // linked worktree root — sandboxed session
    if (kind === "dir") return undefined; // main checkout — not isolated
    const cut = dir.lastIndexOf("/");
    if (cut <= 0) return undefined;
    dir = dir.slice(0, cut);
  }
}

/** Isolation base dir: $OMP_WORKTREE_DIR or ~/.omp/wt (pi-utils getWorktreesDir). */
function isolationBaseDir(): string {
  const envDir =
    typeof process !== "undefined" && process.env ? process.env.OMP_WORKTREE_DIR : undefined;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    typeof process !== "undefined" && process.env ? process.env.HOME : undefined;
  return (home ?? "") + "/.omp/wt";
}

/** Per-repo config from <repoRoot>/.omp/worktree-guard.json, or defaults.
 * Malformed/missing config falls back to defaults (fail open, never throws). */
function repoConfig(repoRoot: string): { sandboxDirs: string[]; strict: boolean } {
  const fallback = { sandboxDirs: DEFAULT_SANDBOX_DIRS, strict: false };
  try {
    const raw = readFileSync(repoRoot + "/.omp/worktree-guard.json", "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return fallback;
    const sandboxDirsRaw = Reflect.get(parsed, "sandboxDirs");
    const strictRaw = Reflect.get(parsed, "strict");
    const sandboxDirs =
      Array.isArray(sandboxDirsRaw) && sandboxDirsRaw.every((d) => typeof d === "string" && d.length > 0)
        ? (sandboxDirsRaw as string[])
        : DEFAULT_SANDBOX_DIRS;
    return { sandboxDirs, strict: strictRaw === true };
  } catch {
    return fallback;
  }
}

/** True when an absolute path is inside a guarded main checkout but outside
 * every sanctioned sandbox. A sandboxDir of ".." sanctions the sibling
 * pattern (outside the root entirely — such targets never reach this
 * function), regular dirs sanction <root>/<dir>/.... Archive/SQLite
 * selectors ("x.zip:inner") keep their base path inside the guard because
 * the container file itself is the mutation. */
function inGuardedArea(abs: string, root: string, sandboxDirs: string[]): boolean {
  if (abs !== root && !abs.startsWith(root + "/")) return false;
  for (const d of sandboxDirs) {
    if (d === "..") continue; // sibling pattern — outside root, nothing to check
    if (abs.startsWith(root + "/" + d + "/") || abs === root + "/" + d) return false;
  }
  return true;
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

      // Session already runs inside an isolation sandbox (ZFS clone, overlay,
      // or any linked worktree): the checkout being edited there is a private
      // copy, so the guard has nothing to protect. An absolute-path escape to
      // the real main checkout still blocks below (repoRootForTarget finds
      // its .git dir).
      if (isolatedSessionRoot(cwd) !== undefined) return;
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
        if (abs === undefined) continue; // not judgeable
        const root = repoRootForTarget(abs);
        if (root === undefined) continue; // worktree or non-repo — sanctioned
        const cfg = repoConfig(root);
        if (cfg.strict) {
          // strict: block any edit inside a known main checkout — sandbox or
          // not. Sibling worktrees are still outside the root and allowed.
          return {
            block: true,
            reason:
              "worktree policy (strict): file edits never land in the checkout " +
              root +
              ". Use a linked worktree outside the repo root (e.g. a sibling " +
              "../<repo>-<feature> directory). Refused target: " +
              r,
          };
        }
        if (inGuardedArea(abs, root, cfg.sandboxDirs)) {
          return {
            block: true,
            reason:
              "worktree policy: file edits never land in the direct checkout " +
              root +
              ". Build the change in a linked worktree (" +
              cfg.sandboxDirs.filter((d) => d !== "..").map((d) => d + "/<feature>").join(", ") +
              " in-repo, or a sibling worktree), commit there, then `git merge <branch>` from the main checkout " +
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
