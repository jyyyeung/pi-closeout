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
 *    persisted, greppable fact (`ok` is false when findings exist).
 *
 * The repo is resolved LAZILY from the session cwd on each hook, not once at
 * extension load: pi is often started outside a repo and then pointed at one,
 * and load-time resolution left this extension (and the identity row it owes
 * the registry) permanently passive in that common case.
 *
 * Disable with CLOSEOUT_DISABLE=1. The checks are harness-agnostic:
 * scripts/session-closeout.sh runs the same gate for humans/other agents.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResult, repoRoot, runCloseout, type GitRunner } from "../src/checks.ts";
import { loadConfig, type CloseoutConfig } from "../src/config.ts";
import { appendRow, resolveRegistry, workIdentity, type RegistryMode } from "../src/registry.ts";

interface Active {
  root: string;
  config: CloseoutConfig;
  registry: RegistryMode;
}

export default function closeoutExtension(pi: ExtensionAPI): void {
  if (process.env.CLOSEOUT_DISABLE === "1") return;

  const name = sessionDisplayName();
  let shortId = "";
  let active: Active | undefined;

  const identity = (): string => workIdentity("pi", shortId, name);

  /** Resolve the repo for this cwd (memoised per root). */
  const forCwd = (cwd: string | undefined): Active | undefined => {
    const dir = cwd ?? process.cwd();
    const root = repoRoot(dir);
    if (!root) return undefined;
    if (!active || active.root !== root) {
      const config = loadConfig(root);
      active = { root, config, registry: resolveRegistry(root, config.registry) };
    }
    return active;
  };

  const gate = (current: Active, strict: boolean, run: GitRunner | undefined = undefined): { count: number; output: string } => {
    const result = runCloseout(current.root, current.config, run);
    appendRow(current.registry, {
      ts: Date.now(),
      type: "closeout",
      name,
      pid: process.pid,
      identity: identity(),
      ok: result.findings.length === 0,
      findings: result.findings.length,
    });
    if (strict && result.findings.length > 0) {
      throw new Error(formatResult(result, identity()));
    }
    return { count: result.findings.length, output: formatResult(result, identity()) };
  };

  pi.on("session_start", async (_event, ctx) => {
    shortId = sessionId(ctx);
    const current = forCwd(ctx?.cwd);
    if (!current) return;
    appendRow(current.registry, { ts: Date.now(), type: "identity", name, pid: process.pid, identity: identity() });
  });

  pi.registerCommand("closeout", {
    description: "Run the session closeout gate (staged sweep-fuel, untracked stash-bait, dirty child repos, open claims, Work-Session trailer gaps)",
    handler: async (args: string, ctx) => {
      const current = forCwd(ctx?.cwd);
      if (!current) {
        report(ctx, "No git repository here — nothing to close out.", "info");
        return;
      }
      const strict = /(^|\s)--strict\b/.test(args ?? "");
      const res = gate(current, strict);
      report(ctx, `${res.count === 0 ? "clean" : `${res.count} finding(s)`}\n\n${res.output}`, res.count > 0 ? "warning" : "info");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = forCwd(ctx?.cwd) ?? active;
    if (!current) return;
    try {
      gate(current, false);
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
