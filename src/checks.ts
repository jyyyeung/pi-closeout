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

export type FindingKind = "staged" | "untracked" | "modified" | "child" | "claim";

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

  return { root, findings, notes };
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
