import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatResult, repoRoot, runCloseout } from "../src/checks.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { appendRow, resolveRegistry, workIdentity } from "../src/registry.ts";

function gitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true }); // tests treat dir as root without git plumbing
  return root;
}

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** GitRunner fake backed by fixture maps — no real git needed for unit tests. */
function fakeRunner(overrides: Record<string, string> = {}): {
  run: (args: string[], cwd: string) => string;
} {
  const defaults: Record<string, string> = {
    "diff,--cached,--name-only": "",
    "ls-files,--others,--exclude-standard": "",
    "status,--short,--untracked-files=no": "",
  };
  const table = { ...defaults, ...overrides };
  return {
    run: (args) => table[args.join(",")] ?? "",
  };
}

test("runCloseout: clean repo -> zero findings, notes present", () => {
  const root = gitRepo();
  const res = runCloseout(root, defaultConfig(), fakeRunner().run);
  assert.equal(res.findings.length, 0);
  assert.ok(res.notes.some((n) => n.includes("nothing staged")));
  assert.ok(res.notes.some((n) => n.includes("clean root tree")));
});

test("runCloseout: staged items flagged as sweep fuel", () => {
  const root = gitRepo();
  const res = runCloseout(
    root,
    defaultConfig(),
    fakeRunner({ "diff,--cached,--name-only": "a.ts\nb.ts" }).run,
  );
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].kind, "staged");
  assert.match(res.findings[0].detail, /sweep fuel/);
});

test("runCloseout: untracked flagged; ignored paths skipped", () => {
  const root = gitRepo();
  const config = defaultConfig();
  config.ignoreUntracked = [".session-registry.jsonl", "evidence.log"];
  const res = runCloseout(
    root,
    config,
    fakeRunner({ "ls-files,--others,--exclude-standard": ".session-registry.jsonl\nevidence.log\nkeep.txt" }).run,
  );
  assert.equal(res.findings.length, 1);
  assert.match(res.findings[0].detail, /keep\.txt/);
});

test("runCloseout: modified root is a note, not a finding", () => {
  const root = gitRepo();
  const res = runCloseout(
    root,
    defaultConfig(),
    fakeRunner({ "status,--short,--untracked-files=no": "M src/a.ts" }).run,
  );
  assert.equal(res.findings.length, 0);
  assert.ok(res.notes.some((n) => n.includes("modified at this root")));
});

test("runCloseout: open claims flagged with file and line", () => {
  const root = gitRepo();
  write(root, "TASKS.md", "line one\nfix auth — claimed @alice 2026-10-18\ndone thing\n");
  const res = runCloseout(root, defaultConfig(), fakeRunner().run);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].kind, "claim");
  assert.match(res.findings[0].detail, /2: fix auth/);
});

test("runCloseout: child repo dirty state flagged", () => {
  const root = gitRepo();
  write(root, "backend/.git/HEAD", "ref: refs/heads/main\n");
  const calls: string[] = [];
  const run = (args: string[], cwd: string) => {
    calls.push(`${cwd}:${args.join(",")}`);
    if (cwd === path.join(root, "backend") && args.join(",") === "status,--short,--untracked-files=no") {
      return "M pom.xml";
    }
    return "";
  };
  const res = runCloseout(root, defaultConfig(), run);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].kind, "child");
  assert.match(res.findings[0].detail, /backend/);
});

test("runCloseout: claims config respected (pattern + files)", () => {
  const root = gitRepo();
  write(root, "TODO.board", "x [claimed by bob]\n");
  const config = defaultConfig();
  config.claimsFiles = ["TODO.board"];
  config.claimPattern = "[claimed by ";
  const res = runCloseout(root, config, fakeRunner().run);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].kind, "claim");
});

test("formatResult: identity echoed; verdict line present", () => {
  const root = gitRepo();
  const res = runCloseout(root, defaultConfig(), fakeRunner().run);
  const out = formatResult(res, "pi/01a2b3c4 (alice)");
  assert.match(out, /Work-Session: pi\/01a2b3c4 \(alice\)/);
  assert.match(out, /session-closeout: clean/);
});

test("config: defaults, merge, bad json tolerated", () => {
  const root = gitRepo();
  assert.deepEqual(loadConfig(root).claimsFiles, ["TASKS.md"]);
  write(root, ".pi-closeout.json", JSON.stringify({ claimsFiles: ["BOARD.md"], childRepos: false }));
  const merged = loadConfig(root);
  assert.deepEqual(merged.claimsFiles, ["BOARD.md"]);
  assert.equal(merged.childRepos, false);
  assert.equal(merged.checkStaged, true); // untouched default
  write(root, ".pi-closeout.json", "{invalid");
  assert.deepEqual(loadConfig(root).claimsFiles, ["TASKS.md"]); // falls back
});

test("registry: auto reuses guard registry, then legacy, then fallback", () => {
  const root = gitRepo();
  // none exist -> fallback
  assert.deepEqual(resolveRegistry(root, "auto"), { path: path.join(root, ".pi-closeout.jsonl") });
  // legacy present -> reused
  write(root, ".session-registry.jsonl", "");
  assert.deepEqual(resolveRegistry(root, "auto"), { path: path.join(root, ".session-registry.jsonl") });
  // guard config registry beats legacy
  write(root, ".pi-checkout-guard.json", JSON.stringify({ registry: "shared/registry.jsonl" }));
  assert.deepEqual(resolveRegistry(root, "auto"), { path: path.join(root, "shared", "registry.jsonl") });
  // explicit wins over all
  assert.deepEqual(resolveRegistry(root, "my.jsonl"), { path: path.join(root, "my.jsonl") });
  assert.equal(resolveRegistry(root, "none"), "none");
});

test("registry: rows appended (identity + closeout), none-mode silent", () => {
  const root = gitRepo();
  const reg = resolveRegistry(root, "auto");
  appendRow(reg, { ts: 1, type: "identity", name: "a", pid: 1, identity: "pi/x (a)" });
  appendRow(reg, { ts: 2, type: "closeout", name: "a", pid: 1, identity: "pi/x (a)", ok: true, findings: 3 });
  const lines = fs.readFileSync(path.join(root, ".pi-closeout.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"findings":3/);
  appendRow("none", { ts: 3, type: "identity", name: "a", pid: 1 });
  assert.equal(lines.length, 2); // no-op
});

test("identity: WORK_SESSION forces; short-id truncation", () => {
  assert.equal(workIdentity("pi", "01a2b3c4d5e6f7g8", "alice", {}), "pi/01a2b3c4 (alice)");
  assert.equal(workIdentity("pi", "", "bob", {}), "pi/unknown (bob)");
  assert.equal(workIdentity("pi", "xyz", "bob", { WORK_SESSION: "custom/id (label)" }), "custom/id (label)");
});

test("identity: PI_SESSION_ID emits bare full id; WORK_SESSION still wins", () => {
  const full = "01a1766a-56af-75c8-a90d-2a0359a79cbc";
  assert.equal(workIdentity("pi", "01a2b3c4", "alice", { PI_SESSION_ID: full }), full);
  assert.equal(
    workIdentity("pi", "01a2b3c4", "alice", { PI_SESSION_ID: full, WORK_SESSION: "forced (x)" }),
    "forced (x)",
  );
  assert.equal(workIdentity("claude", "", "bob", {}), "claude/unknown (bob)");
});

test("repoRoot: real git repo resolves (integration)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-git-"));
  execFileSync("git", ["init", "-q", root]);
  write(root, "a.txt", "x");
  fs.mkdirSync(path.join(root, "sub"));
  const top = repoRoot(path.join(root, "sub"));
  assert.equal(top, root);
});

/* ---------------- Work-Session trailer check (real tmp repos) ---------------- */

/** Real git repo with committed history — the trailer check needs git log. */
function gitHistoryRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-ws-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "closeout@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "closeout-test"]);
  return root;
}

/** Commit a subject, optionally stamped with a Work-Session trailer. Returns short sha. */
function wsCommit(root: string, subject: string, session?: string): string {
  write(root, `f-${Math.random().toString(36).slice(2)}.txt`, String(Math.random()));
  execFileSync("git", ["-C", root, "add", "-A"]);
  const args = ["-C", root, "commit", "-q", "--allow-empty", "-m", subject];
  if (session !== undefined) args.push("-m", `Work-Session: ${session}`);
  execFileSync("git", args);
  return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

test("work-session trailer: auto stays silent when convention absent", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "one");
  wsCommit(root, "two");
  wsCommit(root, "three");
  const res = runCloseout(root, defaultConfig()); // default: "auto"
  assert.equal(res.findings.filter((f) => f.kind === "trailer").length, 0);
  assert.ok(!res.notes.some((n) => n.includes("Work-Session")));
});

test("work-session trailer: flags 2 of 3 recent commits missing it (named short shas)", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "first", "sess-a");
  const sha2 = wsCommit(root, "second");
  const sha3 = wsCommit(root, "third");
  const res = runCloseout(root, defaultConfig());
  const f = res.findings.find((x) => x.kind === "trailer");
  assert.ok(f, "expected a trailer finding");
  assert.match(f!.detail, new RegExp(`${sha2} second — no Work-Session trailer`));
  assert.match(f!.detail, new RegExp(`${sha3} third — no Work-Session trailer`));
  assert.ok(!f!.detail.includes("first")); // trailer-carrying commit not named
});

test("work-session trailer: capped at 10 lines with overflow count", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "base", "sess-0"); // establishes the convention
  for (let i = 1; i <= 15; i++) wsCommit(root, `c${i}`);
  const res = runCloseout(root, defaultConfig());
  const f = res.findings.find((x) => x.kind === "trailer");
  assert.ok(f, "expected a trailer finding");
  const perCommit = f!.detail.split("\n").filter((l) => l.includes("— no Work-Session trailer"));
  assert.equal(perCommit.length, 10);
  assert.match(f!.detail, /…and 5 older commits without trailers/);
});

test("work-session trailer: false disables even with convention present", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "a", "sess-a");
  wsCommit(root, "b");
  const config = defaultConfig();
  config.checkWorkSessionTrailer = false;
  const res = runCloseout(root, config);
  assert.equal(res.findings.filter((f) => f.kind === "trailer").length, 0);
  assert.ok(!res.notes.some((n) => n.includes("Work-Session")));
});

test("work-session trailer: true flags even without prior convention", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "a");
  wsCommit(root, "b");
  const config = defaultConfig();
  config.checkWorkSessionTrailer = true;
  const res = runCloseout(root, config);
  const f = res.findings.find((x) => x.kind === "trailer");
  assert.ok(f, "expected a trailer finding");
  assert.match(f!.detail, /b — no Work-Session trailer/);
});

test("work-session trailer: detached HEAD skips silently", () => {
  const root = gitHistoryRepo();
  wsCommit(root, "a", "sess-a");
  wsCommit(root, "b");
  execFileSync("git", ["-C", root, "checkout", "-q", "--detach", "HEAD"]);
  const res = runCloseout(root, defaultConfig());
  assert.equal(res.findings.filter((f) => f.kind === "trailer").length, 0);
  assert.ok(!res.notes.some((n) => n.includes("Work-Session")));
});

test("config: checkWorkSessionTrailer accepts auto/true/false; invalid falls back", () => {
  const root = gitRepo();
  assert.equal(loadConfig(root).checkWorkSessionTrailer, "auto");
  for (const [value, expected] of [
    ["auto", "auto"],
    [true, true],
    [false, false],
    ["sometimes", "auto"],
    [1, "auto"],
  ] as const) {
    write(root, ".pi-closeout.json", JSON.stringify({ checkWorkSessionTrailer: value }));
    assert.equal(loadConfig(root).checkWorkSessionTrailer, expected);
  }
});
