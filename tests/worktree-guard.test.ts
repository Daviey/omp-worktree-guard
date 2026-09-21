// Unit tests for the worktree-guard decision logic. Run: bun test
//
// Exercises the guard's exported handler against a fake HookAPI, using real
// temp-dir git repos (main checkout + linked worktree) so attribution walks
// hit a real filesystem.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import guard from "../hooks/pre/worktree-guard";

export interface BlockResult {
	block: boolean;
	reason: string;
}

interface FakeApi {
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
	fire: (event: unknown, ctx: unknown) => Promise<BlockResult | undefined>;
}

function fakeApi(): FakeApi {
	const handlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>> = [];
	return {
		on: (_event: string, h: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.push(h),
		fire: async (event: unknown, ctx: unknown): Promise<BlockResult | undefined> =>
			(await Promise.all(handlers.map((h) => h(event, ctx)))).find((r) => r !== undefined) as
				| BlockResult
				| undefined,
	};
}

function sh(cmd: string, cwd: string) {
	execSync(cmd, { cwd, stdio: "pipe" });
}

let api: FakeApi;
let main: string;
let sibling: string;

beforeEach(() => {
	api = fakeApi();
	guard(api as unknown as Parameters<typeof guard>[0]);

	const base = mkdtempSync(path.join(tmpdir(), "wtg-"));
	main = path.join(base, "repo");
	sibling = path.join(base, "repo-sib");
	mkdirSync(main);
	sh("git init -q -b main", main);
	sh("git config user.email t@t && git config user.name t", main);
	writeFileSync(path.join(main, "f.txt"), "x");
	sh("git add -A && git commit -qm init", main);
	sh(`git worktree add -q "${sibling}" -b sib`, main);
	// in-repo sandbox
	sh("git worktree add -q .worktrees/feat -b feat", main);
});

afterEach(() => {
	rmSync(path.dirname(main), { recursive: true, force: true });
});

function editEvent(tool: string, input: Record<string, unknown>, cwd: string) {
	return { toolName: tool, input, };
}

describe("attribution", () => {
	test("blocks write to main checkout (relative)", async () => {
		const r = await api.fire(editEvent("write", { path: "new.txt", content: "x" }, main), { cwd: main });
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("worktree policy");
	});

	test("blocks write to main checkout (absolute, cwd outside repo)", async () => {
		const r = await api.fire(
			editEvent("write", { path: path.join(main, "new.txt"), content: "x" }, tmpdir()),
			{ cwd: tmpdir() },
		);
		expect(r?.block).toBe(true);
	});

	test("allows write inside in-repo sandbox (.worktrees/)", async () => {
		const r = await api.fire(
			editEvent("write", { path: ".worktrees/feat/new.txt", content: "x" }, main),
			{ cwd: main },
		);
		expect(r?.block).toBeUndefined();
	});

	test("allows write inside sibling worktree", async () => {
		const r = await api.fire(
			editEvent("write", { path: path.join(sibling, "new.txt"), content: "x" }, sibling),
			{ cwd: sibling },
		);
		expect(r?.block).toBeUndefined();
	});

	test("allows write outside any repo", async () => {
		const r = await api.fire(
			editEvent("write", { path: path.join(tmpdir(), `wtg-free-${Date.now()}.txt`), content: "x" }, tmpdir()),
			{ cwd: tmpdir() },
		);
		expect(r?.block).toBeUndefined();
	});

	test("blocks edit targeting main checkout via section headers", async () => {
		const payload = {
			input: `[${path.join(main, "f.txt")}#AB12]\nPUT 1.=1:\n+replaced\n`,
		};
		const r = await api.fire(editEvent("edit", payload, main), { cwd: main });
		expect(r?.block).toBe(true);
	});

	test("blocks edit MV destination in main checkout", async () => {
		const payload = {
			input: `[${path.join(main, "f.txt")}#AB12]\nPUT 1.=1:\n+x\nMV lib/moved.ts\n`,
		};
		const r = await api.fire(editEvent("edit", payload, main), { cwd: main });
		expect(r?.block).toBe(true);
	});

	test("ignores non-edit/write tools", async () => {
		const r = await api.fire(editEvent("bash", { command: "rm -rf /" }, main), { cwd: main });
		expect(r?.block).toBeUndefined();
	});

	test("internal URLs are not judgeable", async () => {
		const r = await api.fire(editEvent("write", { path: "xd://report", content: "x" }, main), { cwd: main });
		expect(r?.block).toBeUndefined();
	});
});

describe("per-repo config", () => {
	test("custom sandboxDirs are sanctioned", async () => {
		mkdirSync(path.join(main, ".omp"), { recursive: true });
		writeFileSync(path.join(main, ".omp", "worktree-guard.json"), JSON.stringify({ sandboxDirs: ["sand", ".worktrees"] }));
		mkdirSync(path.join(main, "sand"));
		const r = await api.fire(editEvent("write", { path: "sand/new.txt", content: "x" }, main), { cwd: main });
		expect(r?.block).toBeUndefined();
	});
	test("default sandbox removed when sandboxDirs overridden", async () => {
		mkdirSync(path.join(main, ".omp"), { recursive: true });
		writeFileSync(path.join(main, ".omp", "worktree-guard.json"), JSON.stringify({ sandboxDirs: ["sand"] }));
		// a NON-worktree path under .worktrees/ (no .git file of its own):
		// attribution lands on the main checkout, and the overridden config
		// no longer sanctions .worktrees/
		mkdirSync(path.join(main, ".worktrees", "plain"), { recursive: true });
		const r = await api.fire(editEvent("write", { path: ".worktrees/plain/new.txt", content: "x" }, main), { cwd: main });
		expect(r?.block).toBe(true);
	});

	test("strict blocks even inside sandbox", async () => {
		mkdirSync(path.join(main, ".omp"), { recursive: true });
		writeFileSync(path.join(main, ".omp", "worktree-guard.json"), JSON.stringify({ strict: true }));
		// same: a plain dir under .worktrees/ (not a linked worktree) —
		// strict must block it; actual linked worktrees stay allowed below
		mkdirSync(path.join(main, ".worktrees", "plain"), { recursive: true });
		const r = await api.fire(editEvent("write", { path: ".worktrees/plain/new.txt", content: "x" }, main), { cwd: main });
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("strict");
	});
	test("malformed config falls back to defaults", async () => {
		mkdirSync(path.join(main, ".omp"), { recursive: true });
		writeFileSync(path.join(main, ".omp", "worktree-guard.json"), "{ not json");
		const r = await api.fire(editEvent("write", { path: ".worktrees/plain/new.txt", content: "x" }, main), { cwd: main });
		// plain dir under .worktrees/: default config sanctions .worktrees/,
		// so malformed config falls back and allows it
		expect(r?.block).toBeUndefined();
	});
	test("strict still allows sibling worktrees", async () => {
		mkdirSync(path.join(main, ".omp"), { recursive: true });
		writeFileSync(path.join(main, ".omp", "worktree-guard.json"), JSON.stringify({ strict: true }));
		const r = await api.fire(
			editEvent("write", { path: path.join(sibling, "new.txt"), content: "x" }, sibling),
			{ cwd: sibling },
		);
		expect(r?.block).toBeUndefined();
	});
});

describe("isolated session exemption", () => {
	test("allows edits when the session cwd sits under the omp isolation base (zfs clone)", async () => {
		// Fake an isolation clone: <base>/t<digest>/m/<copy of repo files>
		const isoRoot = path.join(path.dirname(main), "fake-wt", "tabc123", "m");
		mkdirSync(isoRoot, { recursive: true });
		writeFileSync(path.join(isoRoot, "f.txt"), "cloned");
		// No .git at all — the zfs clone shape this host produces.
		const r = await api.fire(editEvent("write", { path: "new.txt", content: "x" }, isoRoot), {
			cwd: isoRoot,
		});
		expect(r?.block).toBeUndefined();
	});

	test("isolation base honors OMP_WORKTREE_DIR override", async () => {
		const customBase = path.join(path.dirname(main), "custom-wt");
		const isoRoot = path.join(customBase, "txyz", "m");
		mkdirSync(isoRoot, { recursive: true });
		process.env.OMP_WORKTREE_DIR = customBase;
		try {
			const r = await api.fire(editEvent("write", { path: "new.txt", content: "x" }, isoRoot), {
				cwd: isoRoot,
			});
			expect(r?.block).toBeUndefined();
		} finally {
			delete process.env.OMP_WORKTREE_DIR;
		}
	});

	test("allows edits when the session cwd is a linked git worktree", async () => {
		// `sibling` is a real linked worktree (created in beforeEach).
		const r = await api.fire(editEvent("write", { path: "new.txt", content: "x" }, sibling), {
			cwd: sibling,
		});
		expect(r?.block).toBeUndefined();
	});

	test("absolute-path escape from an isolated session to the real main checkout still blocks", async () => {
		const isoRoot = path.join(path.dirname(main), "fake-wt2", "tdef456", "m");
		mkdirSync(isoRoot, { recursive: true });
		const r = await api.fire(
			editEvent("write", { path: path.join(main, "escaped.txt"), content: "x" }, isoRoot),
			{ cwd: isoRoot },
		);
		expect(r?.block).toBe(true);
	});
});
