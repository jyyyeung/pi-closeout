/**
 * Registry rows + Work-Session identity.
 *
 * Identity convention: pi sessions emit the bare full PI_SESSION_ID (the
 * exact string a commit carries as a `Work-Session:` trailer); other
 * harnesses fall back to `harness/<short-id> (<label>)`. Rows are appended to the
 * workspace registry when one exists (pi-checkout-guard compatible: presence
 * rows from that package and identity/closeout rows from this one interleave
 * in one file).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type RegistryMode = { path: string } | "none";

/** Fallback row file name (used when no guard registry is discoverable). */
export const REGISTRY_FILE = ".pi-closeout.jsonl";

/**
 * Last-resort registry location. Inside a real git repo this lives under the
 * git dir, NOT the worktree: a registry in the worktree would be an untracked
 * file that the closeout gate itself then reports as a finding, and it would
 * pollute every `git status` in the shared checkout. Only a non-git root (or a
 * linked worktree, where .git is a file) falls back to the root, and there
 * config.ignoreUntracked keeps that name out of findings.
 */
export function fallbackRegistryPath(root: string): string {
  const gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isDirectory()) return path.join(gitDir, "pi-closeout", "registry.jsonl");
  } catch {
    /* no git dir */
  }
  return path.join(root, REGISTRY_FILE);
}

/**
 * Resolve where rows go. "auto": reuse a pi-checkout-guard registry when one
 * is discoverable (git common dir, root .pi-checkout-guard/, or legacy
 * .session-registry.jsonl), else fallbackRegistryPath(root).
 */
export function resolveRegistry(root: string, config: string): RegistryMode {
  if (config === "none") return "none";
  if (config !== "auto") {
    return { path: path.isAbsolute(config) ? config : path.join(root, config) };
  }
  const candidates = [
    path.join(root, ".session-registry.jsonl"),
  ];
  const gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isDirectory()) {
      candidates.unshift(path.join(gitDir, "pi-checkout-guard", "registry.jsonl"));
    }
  } catch {
    /* not a dir */
  }
  const guardConfig = path.join(root, ".pi-checkout-guard.json");
  try {
    const raw = JSON.parse(fs.readFileSync(guardConfig, "utf8")) as { registry?: string };
    if (typeof raw.registry === "string" && raw.registry) {
      // Configured path wins even when the file does not exist yet — the
      // guard creates it on first session; closeout appends (mkdir -p).
      return { path: path.isAbsolute(raw.registry) ? raw.registry : path.join(root, raw.registry) };
    }
  } catch {
    /* no/invalid guard config */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return { path: c };
  }
  return { path: fallbackRegistryPath(root) };
}

export interface CloseoutRow {
  ts: number;
  type: "identity" | "closeout";
  name: string;
  pid: number;
  identity?: string;
  findings?: number;
  ok?: boolean;
}

export function appendRow(registry: RegistryMode, row: CloseoutRow): void {
  if (registry === "none") return;
  try {
    fs.mkdirSync(path.dirname(registry.path), { recursive: true });
    fs.appendFileSync(registry.path, JSON.stringify(row) + "\n");
  } catch {
    /* registry write is best-effort */
  }
}

/**
 * Identity for commit trailers. Precedence: WORK_SESSION force, then the
 * bare full PI_SESSION_ID (pi harness convention: no prefix, no label),
 * then the legacy `harness/<8-char-id> (label)` form for other harnesses.
 */
export function workIdentity(
  harness: string,
  shortId: string,
  label: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const forced = env.WORK_SESSION;
  if (forced) return forced;
  const sessionId = env.PI_SESSION_ID;
  if (sessionId) return sessionId;
  const id = shortId ? shortId.slice(0, 8) : "unknown";
  return `${harness}/${id} (${label})`;
}
