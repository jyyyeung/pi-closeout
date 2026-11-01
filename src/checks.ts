/**
 * Closeout checks — pure logic driving git via an injectable exec runner, so
 * tests run against real tmp repos without spawning the extension.
 *
 * All checks are informational by default; "findings" are the loose ends the
 * session is leaving behind. Nothing here mutates state.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CloseoutConfig } from "./config.ts";

export type FindingKind = "staged" | "untracked" | "modified" | "child" | "claim" | "trailer";

export interface Finding {
  kind: FindingKind;
  detail: string;
}

export interface CloseoutResult {
  root: string;
  findings: Finding[];
  notes: string[];
}

export type GitRunner = (args: string[], cwd: string) => string;

export function gitRunner(timeoutMs = 10_000): GitRunner {
  return (args, cwd) =>
    execFileSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Repo root for a cwd — works inside linked worktrees too. */
export function repoRoot(cwd: string, run: GitRunner = gitRunner()): string | null {
  try {
    const top = run(["rev-parse", "--show-toplevel"], cwd);
    return top || null;
  } catch {
    return null;
  }
}

export function runCloseout(
  root: string,
  config: CloseoutConfig,
  run: GitRunner = gitRunner(),
  readdir: (p: string) => fs.Dirent[] = (p) => fs.readdirSync(p, { withFileTypes: true }),
): CloseoutResult {
  const findings: Finding[] = [];
  const notes: string[] = [];

  if (config.checkStaged) {
    const staged = safe(() => run(["diff", "--cached", "--name-only"], root));
    if (staged) {
      findings.push({
        kind: "staged",
        detail: `staged-but-uncommitted (concurrent-session sweep fuel):\n${indent(staged)}`,
      });
    } else {
      notes.push("nothing staged");
    }
  }

  if (config.checkUntracked) {
    const untracked = safe(() => run(["ls-files", "--others", "--exclude-standard"], root))
      .split("\n")
      .filter((l) => l && !config.ignoreUntracked.includes(l));
    if (untracked.length > 0) {
      findings.push({
        kind: "untracked",
        detail: `untracked files (stash-cycle bait — commit, move, or own them):\n${indent(untracked.join("\n"))}`,
      });
    } else {
      notes.push("no untracked files");
    }
  }

  const modified = safe(() => run(["status", "--short", "--untracked-files=no"], root));
  if (modified) {
    notes.push(`modified at this root (finish, claim, or hand off):\n${indent(modified)}`);
  } else {
    notes.push("clean root tree");
  }

  if (config.childRepos) {
    let childFindings = 0;
    for (const child of childRepos(root, readdir)) {
      const dirty = safe(() => run(["status", "--short", "--untracked-files=no"], child));
      if (dirty) {
        childFindings++;
        const lines = dirty.split("\n").length;
        findings.push({ kind: "child", detail: `child repo '${child}' has uncommitted changes (${lines} files)` });
      }
    }
    if (childFindings === 0) notes.push("child repos clean (or none present)");
  }

  const claimRe = new RegExp(escapeRegExp(config.claimPattern));
  for (const file of config.claimsFiles) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const claims = fs
      .readFileSync(p, "utf8")
      .split("\n")
      .map((line, i) => ({ line: line.trimEnd(), no: i + 1 }))
      .filter((l) => claimRe.test(l.line));
    if (claims.length > 0) {
      findings.push({
        kind: "claim",
        detail: `open claims in ${file} (resolve or re-claim):\n${indent(claims.map((c) => `${c.no}: ${c.line}`).join("\n"))}`,
      });
    }
  }

  workSessionTrailerCheck(root, config.checkWorkSessionTrailer, run, findings, notes);

  return { root, findings, notes };
}

/* ---------------------------------------------------------------- *
 * Work-Session trailer check.
 *
 * Advisory convention: hosts may stamp commits with a `Work-Session: <id>`
 * trailer via prepare-commit-msg. When the injection misses, the gap only
 * surfaces later (broken provenance queries). Catch it at closeout — but
 * only where the convention is in use: "auto" skips silently when none of
 * the last 30 commits on HEAD carries the trailer, so convention-less
 * repos get zero output. Merge commits are excluded (`--no-merges`): the
 * git server, not a local prepare-commit-msg hook, creates UI-generated
 * merge commits, so they never carry the trailer by design.
 * ---------------------------------------------------------------- */

/** Detection window and per-finding cap. */
const WS_WINDOW = 30;
const WS_CAP = 10;

interface CommitRecord {
  sha: string;
  subject: string;
  hasWorkSession: boolean;
}

/** One trailer line counts when the key is Work-Session and the value is non-empty. */
const WS_TRAILER_RE = /^[\t ]*Work-Session:[\t ]*(.*?)[\t ]*$/i;

function hasWorkSessionTrailer(trailers: string): boolean {
  return trailers.split("\n").some((line) => {
    const m = WS_TRAILER_RE.exec(line);
    return m !== null && m[1].length > 0;
  });
}

/** Parse `--pretty=format:%h%x1f%s%x1f%(trailers)%x1e` output (plain %(trailers): git >= 2.14). */
function parseTrailerLog(out: string): CommitRecord[] {
  if (!out) return [];
  const commits: CommitRecord[] = [];
  for (const record of out.split("\u001e")) {
    const parts = record.replace(/^\n/, "").split("\u001f");
    if (parts.length < 3 || !parts[0]) continue;
    commits.push({
      sha: parts[0],
      subject: parts[1],
      hasWorkSession: hasWorkSessionTrailer(parts.slice(2).join("\u001f")),
    });
  }
  return commits;
}

function workSessionTrailerCheck(
  root: string,
  mode: "auto" | boolean,
  run: GitRunner,
  findings: Finding[],
  notes: string[],
): void {
  if (mode === false) return;
  // Detached HEAD (or git error): skip silently — checks never throw.
  if (!safe(() => run(["symbolic-ref", "--quiet", "HEAD"], root))) return;
  const recent = parseTrailerLog(
    safe(() => run(["log", "-n", String(WS_WINDOW), "--no-merges", "--pretty=format:%h%x1f%s%x1f%(trailers)%x1e"], root)),
  );
  const conventionInUse = mode === true || recent.some((c) => c.hasWorkSession);
  if (!conventionInUse) return; // auto + convention absent: silent
  const missing = recent.filter((c) => !c.hasWorkSession);
  if (missing.length === 0) {
    if (recent.length > 0) notes.push("recent commits carry Work-Session trailers");
    return;
  }
  const lines = missing.slice(0, WS_CAP).map((c) => `${c.sha} ${c.subject} — no Work-Session trailer`);
  const overflow = missing.length - WS_CAP;
  if (overflow > 0) lines.push(`…and ${overflow} older commits without trailers`);
  findings.push({
    kind: "trailer",
    detail: `recent commits missing the Work-Session trailer (provenance queries will miss them):\n${indent(lines.join("\n"))}`,
  });
}

function childRepos(root: string, readdir: (p: string) => fs.Dirent[]): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdir(root)) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name.startsWith(".")) continue;
      const child = path.join(root, entry.name);
      if (isGitDir(child)) {
        out.push(child);
        continue;
      }
      try {
        for (const sub of readdir(child)) {
          if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
          const grand = path.join(child, sub.name);
          if (isGitDir(grand)) out.push(grand);
        }
      } catch {
        /* unreadable */
      }
    }
  } catch {
    /* unreadable root */
  }
  return out.sort();
}

function isGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function safe(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "";
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatResult(result: CloseoutResult, identity: string): string {
  const head = [`session closeout — ${result.root}`];
  if (identity) head.push(`  identity: Work-Session: ${identity}`);
  for (const n of result.notes) head.push(`  ✓/• ${n}`);
  for (const f of result.findings) head.push(`  ✗ [${f.kind}] ${f.detail}`);
  head.push(result.findings.length > 0 ? `session-closeout: ${result.findings.length} finding(s)` : "session-closeout: clean");
  return head.join("\n");
}
