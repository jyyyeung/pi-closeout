# pi-closeout

Session closeout gate for coding agents: **catch the loose ends a work
session leaves behind before they become someone else's incident.**

On a shared checkout, the session that ends dirty sets up the next session's
failure: staged-but-uncommitted files get swept into whoever commits next;
untracked evidence gets eaten by the next stash cycle; unclaimed task lines
go stale and block the board. pi-closeout makes "how did this session end?"
a checkable, persisted fact.

```
$ /closeout
session closeout — /repo
  ✓ nothing staged
  ✗ [untracked] untracked files (stash-cycle bait — commit, move, or own them):
      evidence/r4-fails-on-main.txt
  ✓ clean root tree
  ✗ [claim] open claims in TASKS.md (resolve or re-claim):
      12: fix pagination — claimed @alice 2026-10-18
session-closeout: 2 finding(s)
```

## What it does

| Layer | Behavior |
|---|---|
| **Closeout gate** | Flags staged-but-uncommitted (sweep fuel), untracked files (stash-bait), dirty child repos (nested `.git`, depth ≤ 2), and open claims in your task file. Modified-but-committed-nothing root files are informational notes. |
| **`/closeout` command** | Runs the gate, reports inline. `--strict` throws on findings (script/CI use). |
| **Shutdown gate** | Runs once, best-effort, at session end — records the findings count so "closed with N loose ends" is greppable history. Never blocks shutdown. |
| **Work-Session identity** | At session start, derives the identity string (bare full PI_SESSION_ID on pi; legacy `harness/<id8> (name)` elsewhere) and appends an identity row — the exact string commits should carry as a `Work-Session:` trailer (advisory). |
| **Registry synergy** | Reuses a [pi-checkout-guard](https://github.com/jyyyeung/pi-checkout-guard) registry when present (identity/closeout rows interleave with presence rows), a legacy `.session-registry.jsonl`, or falls back to `.pi-closeout.jsonl`. |
| **Harness-agnostic script** | `scripts/session-closeout.sh` runs the same gate for humans, Claude Code (`Stop` hook), Codex, cron — env-configurable, zero dependencies beyond git. |

**Work-Session trailers.** Some host setups stamp every commit with an
advisory `Work-Session: <session-id>` trailer (via a prepare-commit-msg hook),
so later provenance queries can attribute commits to sessions. On detached or
edge commit paths the injection can miss, and the gap only surfaces when those
queries come up empty. The gate flags recent commits missing the trailer — the
10 most recent, plus an overflow count. Detection is automatic and quiet: it
inspects the last 30 commits, and if none carries a `Work-Session` trailer the
convention is treated as not in use and the check emits nothing at all — repos
that never adopted it get zero extra output.

## Install

```bash
pi install npm:pi-closeout
```

Zero-config in any git repository. Optional `.pi-closeout.json` at the repo
root:

```json
{
  "claimsFiles": ["TASKS.md"],
  "claimPattern": "— claimed @",
  "childRepos": true,
  "checkStaged": true,
  "checkUntracked": true,
  "ignoreUntracked": [".session-registry.jsonl"],
  "registry": "auto",
  "checkWorkSessionTrailer": "auto"
}
```

| Key | Default | Meaning |
|---|---|---|
| `claimsFiles` | `["TASKS.md"]` | Files scanned for open claims. |
| `claimPattern` | `"— claimed @ "` | Substring marking a claimed line. |
| `childRepos` | `true` | Check nested repos (depth ≤ 2) for dirty trees. |
| `checkStaged` / `checkUntracked` | `true` | Toggle the two hard findings. |
| `ignoreUntracked` | see above | Untracked paths never flagged. |
| `registry` | `"auto"` | `"auto"` / `"none"` / explicit path for identity+closeout rows. |
| `checkWorkSessionTrailer` | `"auto"` | `"auto"` flags commits missing the `Work-Session:` trailer only when the convention is detected in the last 30 commits (completely silent otherwise); `true` always checks; `false` disables. |

Disable entirely with `CLOSEOUT_DISABLE=1`. Set `WORK_SESSION` to force the
identity string (any harness).

### Claude Code wiring

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "bash /path/to/session-closeout.sh" }] }] } }
```

## How this differs from neighbors

Static hygiene hooks lint the tree on every command; pi-closeout is
**lifecycle-scoped** — it fires when a session *ends* (or on demand), grades
findings by how they hurt the *next* session, and persists a per-session
closeout row. Pair it with pi-checkout-guard (which guards concurrent
mutations) for full shared-checkout hygiene: guard = during, closeout =
after.

## Registry rows

```jsonl
{"ts":1730000000000,"type":"identity","name":"alice","pid":4242,"identity":"01a2b3c4-56af-75c8-a90d-2a0359a79cbc"}
{"ts":1730000600000,"type":"closeout","name":"alice","pid":4242,"identity":"01a2b3c4-56af-75c8-a90d-2a0359a79cbc","ok":true,"findings":2}
```

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © jyyyeung
