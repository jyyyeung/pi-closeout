/**
 * pi-closeout extension for the pi coding agent.
 *
 * 1. IDENTITY — session_start appends a Work-Session identity row (the bare
 *    full session id on pi; legacy `harness/<id8> (name)` elsewhere) to the
 *    workspace registry. That string is what
 *    commits should carry as a `Work-Session:` trailer.
 *
 * 2. GATE — `/closeout` runs the closeout checks (staged sweep-fuel,
 *    untracked stash-bait, dirty child repos, open claims, Work-Session
 *    trailer gaps — auto-detected, silent where the convention is unused)
 *    and reports findings inline. `--strict` prefix exits nonzero (for scripts).
 *
 * 3. SHUTDOWN — session_shutdown runs the gate best-effort and records the
 *    findings count, so "this session closed with N loose ends" is a
 *    persisted, greppable fact.
 *
 * Disable with CLOSEOUT_DISABLE=1. The checks are harness-agnostic:
 * scripts/session-closeout.sh runs the same gate for humans/other agents.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResult, repoRoot, runCloseout, type GitRunner } from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { appendRow, resolveRegistry, workIdentity } from "../src/registry.ts";

export default function closeoutExtension(pi: ExtensionAPI): void {
  if (process.env.CLOSEOUT_DISABLE === "1") return;

  const cwd = process.cwd();
  const root = repoRoot(cwd);
  if (!root) return; // not a git repo; passive

  const config = loadConfig(root);
  const registry = resolveRegistry(root, config.registry);
  const name = sessionDisplayName();
  let shortId = "";

  const identity = (): string => workIdentity("pi", shortId, name);

  const gate = (strict: boolean, run: GitRunner | undefined = undefined): { count: number; output: string } => {
    const result = runCloseout(root, config, run);
    appendRow(registry, { ts: Date.now(), type: "closeout", name, pid: process.pid, identity: identity(), ok: true, findings: result.findings.length });
    if (strict && result.findings.length > 0) {
      throw new Error(formatResult(result, identity()));
    }
    return { count: result.findings.length, output: formatResult(result, identity()) };
  };

  pi.on("session_start", async (_event, ctx) => {
    shortId = sessionId(ctx);
    appendRow(registry, { ts: Date.now(), type: "identity", name, pid: process.pid, identity: identity() });
  });

  pi.registerCommand("closeout", {
    description: "Run the session closeout gate (staged sweep-fuel, untracked stash-bait, dirty child repos, open claims, Work-Session trailer gaps)",
    handler: async (args: string, ctx) => {
      const strict = /(^|\s)--strict\b/.test(args ?? "");
      const res = gate(strict);
      report(ctx, `${res.count === 0 ? "clean" : `${res.count} finding(s)`}\n\n${res.output}`, res.count > 0 ? "warning" : "info");
    },
  });

  pi.on("session_shutdown", async () => {
    try {
      gate(false);
    } catch {
      /* best-effort: the process is exiting */
    }
  });
}

function sessionDisplayName(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): string {
  const envName = env.PI_SESSION_NAME || env.PI_SESSION;
  if (envName) return envName;
  const i = argv.indexOf("--name");
  if (i > 0 && argv[i + 1]) return String(argv[i + 1]);
  return `pid-${process.pid}`;
}

function sessionId(ctx: unknown): string {
  try {
    const sm = (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager;
    const id = sm?.getSessionId?.();
    return typeof id === "string" && id ? id : "";
  } catch {
    return "";
  }
}

function report(ctx: { ui?: { notify?: (msg: string, level?: "info" | "warning" | "error") => void } }, message: string, level: "info" | "warning"): void {
  try {
    ctx.ui?.notify?.(message, level);
  } catch {
    /* non-interactive mode */
  }
}
