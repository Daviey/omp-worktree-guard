// /wt — slash command for the worktree-isolation workflow.
//
// Subcommands (run from anywhere inside a git repo):
//   /wt <feature>        create .worktrees/<feature> on a new branch (or
//                        check out the existing branch) and print the path
//   /wt merge <feature>  merge <feature> into the current branch, then
//                        remove the .worktrees/<feature> worktree
//   /wt list             list worktrees and their branches
//   /wt clean            remove worktrees whose branches are merged into HEAD
//
// Part of omp-worktree-guard (the guard blocks main-checkout edits; this
// command automates the sanctioned workflow).

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

function git(pi: ExtensionAPI, ctx: ExtensionCommandContext, ...args: string[]) {
	return pi.exec("git", args, { cwd: ctx.cwd });
}

function lines(blocks: string, re: RegExp): Array<{ block: string; m: RegExpExecArray }> {
	const out: Array<{ block: string; m: RegExpExecArray }> = [];
	for (const block of blocks.split("\n\n")) {
		const m = re.exec(block);
		if (m) out.push({ block, m });
	}
	return out;
}

export default function wtCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wt", {
		description: "worktree workflow: create/merge/list/clean linked worktrees",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0] ?? "list";

			if (sub === "list") {
				const r = await git(pi, ctx, "worktree", "list");
				await ctx.ui.notify(r.stdout.trim() || "no worktrees", "info");
				return;
			}

			const feature = argv[1];
			if (!feature) {
				await ctx.ui.notify("usage: /wt <feature> | /wt merge <feature> | /wt list | /wt clean", "error");
				return;
			}

			if (sub === "merge") {
				const merge = await git(pi, ctx, "merge", feature, "--no-edit");
				if (merge.code !== 0) {
					await ctx.ui.notify(`merge failed:\n${merge.stdout}\n${merge.stderr}`, "error");
					return;
				}
				const rm = await git(pi, ctx, "worktree", "remove", `.worktrees/${feature}`);
				if (rm.code !== 0) {
					await ctx.ui.notify(`merged ${feature}, but worktree removal failed: ${rm.stderr.trim()}`, "error");
					return;
				}
				const bd = await git(pi, ctx, "branch", "-d", feature);
				await ctx.ui.notify(
					`merged ${feature}, removed .worktrees/${feature}${bd.code === 0 ? `, deleted branch ${feature}` : ` (branch delete: ${bd.stderr.trim()})`}`,
					"success",
				);
				return;
			}

			if (sub === "clean") {
				const list = await git(pi, ctx, "worktree", "list", "--porcelain");
				// remove every worktree whose branch is fully merged into HEAD;
				// unmerged branches keep their worktrees
				let removed = 0;
				let kept = 0;
				for (const { block, m } of lines(list.stdout, /^worktree (.+)$/m)) {
					const path = m[1];
					const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
					if (!branch) continue;
					const merged = await git(pi, ctx, "merge-base", "--is-ancestor", branch, "HEAD");
					if (merged.code !== 0) {
						kept++;
						continue;
					}
					const r = await git(pi, ctx, "worktree", "remove", path);
					if (r.code === 0) removed++;
				}
				await ctx.ui.notify(
					removed ? `removed ${removed} merged worktree(s), ${kept} kept (unmerged)` : "no merged worktrees to remove",
					"info",
				);
				return;
			}


			// default: /wt <feature> — create (or reuse) the worktree
			const feature2 = sub;
			const branchExists = await git(pi, ctx, "rev-parse", "--verify", `refs/heads/${feature2}`);
			const create = branchExists.code === 0
				? await git(pi, ctx, "worktree", "add", `.worktrees/${feature2}`, feature2)
				: await git(pi, ctx, "worktree", "add", "-b", feature2, `.worktrees/${feature2}`);
			if (create.code !== 0) {
				await ctx.ui.notify(`worktree create failed:\n${create.stderr.trim()}`, "error");
				return;
			}
			const abs = await git(pi, ctx, "rev-parse", "--show-toplevel");
			const root = abs.stdout.trim();
			await ctx.ui.notify(
				`worktree ready: ${root}/.worktrees/${feature2} (branch ${feature2})\ncd ${root}/.worktrees/${feature2} — build there; /wt merge ${feature2} when done`,
				"success",
			);
		},
	});
}
