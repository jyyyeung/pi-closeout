/**
 * pi-closeout — session closeout gate.
 *
 * Checks a work session is not leaving loose ends on a (possibly shared)
 * checkout: staged-but-uncommitted items, untracked stash-bait, dirty child
 * repos, open task claims. See README.md for the failure classes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CloseoutConfig {
  /** Files scanned for open claims (relative to repo root). */
  claimsFiles: string[];
  /** A line matching this regex inside a claims file counts as an open claim. */
  claimPattern: string;
  /** Check child repos (nested .git dirs, depth <= 2) for dirty trees. */
  childRepos: boolean;
  /** Flag staged-but-uncommitted items (concurrent-session sweep fuel). */
  checkStaged: boolean;
  /** Flag untracked files (stash-cycle bait). */
  checkUntracked: boolean;
  /** Untracked paths never counted as findings (registry/config files). */
  ignoreUntracked: string[];
  /**
   * Flag recent commits missing a `Work-Session:` trailer. "auto" (default)
   * runs the check only when the convention is already in use — any of the
   * last 30 commits on HEAD carries the trailer; otherwise the check stays
   * completely silent. `true` always checks; `false` disables.
   */
  checkWorkSessionTrailer: "auto" | boolean;
  /**
   * Where identity/closeout rows are appended: "auto" (reuse a
   * pi-checkout-guard registry when present, else <root>/.pi-closeout.jsonl),
   * "none", or an explicit path (absolute, or relative to repo root).
   */
  registry: "auto" | "none" | string;
}

/** Config file at the repo root customizes checks (optional). */
export const CONFIG_FILE = ".pi-closeout.json";

export function defaultConfig(): CloseoutConfig {
  return {
    claimsFiles: ["TASKS.md"],
    claimPattern: "— claimed @",
    childRepos: true,
    checkStaged: true,
    checkUntracked: true,
    ignoreUntracked: [".session-registry.jsonl", CONFIG_FILE],
    registry: "auto",
    checkWorkSessionTrailer: "auto",
  };
}

export function loadConfig(root: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): CloseoutConfig {
  const merged = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path.join(root, CONFIG_FILE)));
  } catch {
    return merged;
  }
  if (typeof raw !== "object" || raw === null) return merged;
  const c = raw as Record<string, unknown>;
  if (Array.isArray(c.claimsFiles)) {
    merged.claimsFiles = c.claimsFiles.filter((f): f is string => typeof f === "string" && f.length > 0);
  }
  if (typeof c.claimPattern === "string" && c.claimPattern) merged.claimPattern = c.claimPattern;
  if (typeof c.childRepos === "boolean") merged.childRepos = c.childRepos;
  if (typeof c.checkStaged === "boolean") merged.checkStaged = c.checkStaged;
  if (typeof c.checkUntracked === "boolean") merged.checkUntracked = c.checkUntracked;
  if (Array.isArray(c.ignoreUntracked)) {
    merged.ignoreUntracked = c.ignoreUntracked.filter((f): f is string => typeof f === "string");
  }
  if (typeof c.registry === "string" && c.registry) merged.registry = c.registry;
  const ws = c.checkWorkSessionTrailer;
  if (ws === "auto" || ws === true || ws === false) merged.checkWorkSessionTrailer = ws;
  return merged;
}
