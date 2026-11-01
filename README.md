# pi-closeout

[![npm](https://img.shields.io/npm/v/pi-closeout?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-closeout) [![CI](https://img.shields.io/github/actions/workflow/status/jyyyeung/pi-closeout/test.yml?style=flat&logo=github&label=CI)](https://github.com/jyyyeung/pi-closeout/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![Pi](https://img.shields.io/badge/pi-%E2%89%A51.3-6366F1?style=flat)](https://pi.dev) [![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)

Session closeout gate for coding agents: **catch the loose ends a work session
leaves behind before they become someone else's incident.**

On a shared checkout, the session that ends dirty sets up the next session's
failure: staged-but-uncommitted files get swept into whoever commits next;
untracked evidence gets eaten by the next stash cycle; unclaimed task lines go
stale and block the board. pi-closeout makes "how did this session end?" a
checkable, persisted fact.

Install it if more than one session ever works in the same checkout, or if you
have been bitten by a commit that silently absorbed someone else's staged file.

## Install

```bash
pi install npm:pi-closeout
```

Then restart pi (or `/reload`). Zero-config in any git repository.

From a local checkout:

```bash
pi install ./pi-closeout
pi -e ./pi-closeout/extensions/closeout.ts
```

## Quick start

When the session ends — or when you ask:

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

`--strict` throws on findings instead of reporting them, for script and CI use.
The shutdown gate runs the same checks once at session end, best-effort, and
records the count in the registry so "closed with N loose ends" is greppable
history. It never blocks shutdown.

## What it does

| Layer | Behavior |
|---|---|
| **Closeout gate** | Flags staged-but-uncommitted (sweep fuel), untracked files (stash-bait), dirty child repos (nested `.git`, depth ≤ 2), and open claims in your task file. Modified-but-committed-nothing root files are informational notes. |
| **`/closeout` command** | Runs the gate, reports inline. `--strict` throws on findings (script/CI use). |
| **Shutdown gate** | Runs once, best-effort, at session end — records the findings count so "closed with N loose ends" is greppable history. Never blocks shutdown. |
| **Work-Session identity** | At session start, derives the identity string (bare full PI_SESSION_ID on pi; legacy `harness/<id8> (name)` elsewhere) and appends an identity row — the exact string commits should carry as a `Work-Session:` trailer (advisory). |
| **Registry synergy** | Reuses a [pi-checkout-guard](https://github.com/jyyyeung/pi-checkout-guard) registry when present (identity/closeout rows interleave with presence rows), a legacy `.session-registry.jsonl`, or falls back to `.git/pi-closeout/registry.jsonl` — inside the git dir, so the registry never becomes an untracked file the gate itself reports. |
| **Harness-agnostic script** | `scripts/session-closeout.sh` runs the same gate for humans, Claude Code (`Stop` hook), Codex, cron — env-configurable, zero dependencies beyond git. |

### Work-Session trailers

Some host setups stamp every commit with an advisory `Work-Session: <session-id>`
trailer (via a prepare-commit-msg hook), so later provenance queries can
attribute commits to sessions. On detached or edge commit paths the injection
can miss, and the gap only surfaces when those queries come up empty. The gate
flags recent commits missing the trailer — the 10 most recent, plus an overflow
count.

Detection is automatic and quiet: it inspects the last 30 commits, and if none
carries a `Work-Session` trailer the convention is treated as not in use and the
check emits nothing at all — repos that never adopted it get zero extra output.
Where the convention *is* in use, `"auto"` only looks at commits **newer than
the newest trailer-bearing commit**: history from before adoption (`init`, first
imports) is not a gap, and flagging it buried the one real miss in a wall of
pre-convention noise.

## Configuration (`.pi-closeout.json`)

Optional, at the repo root:

```json
{
  "claimsFiles": ["TASKS.md"],
  "claimPattern": "— claimed @",
  "childRepos": true,
  "checkStaged": true,
  "checkUntracked": true,
  "ignoreUntracked": [".session-registry.jsonl", ".pi-closeout.jsonl"],
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
| `checkWorkSessionTrailer` | `"auto"` | `"auto"` flags commits missing the `Work-Session:` trailer only when the convention is detected in the last 30 commits, and only for commits newer than the newest stamped one (completely silent otherwise); `true` checks every non-merge commit in the window; `false` disables. |

Disable entirely with `CLOSEOUT_DISABLE=1`. Set `WORK_SESSION` to force the
identity string (any harness).

### Claude Code wiring

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "bash /path/to/session-closeout.sh" }] }] } }
```

## Registry rows

```jsonl
{"ts":1730000000000,"type":"identity","name":"alice","pid":4242,"identity":"01a2b3c4-56af-75c8-a90d-2a0359a79cbc"}
{"ts":1730000600000,"type":"closeout","name":"alice","pid":4242,"identity":"01a2b3c4-56af-75c8-a90d-2a0359a79cbc","ok":true,"findings":2}
```

## How this differs from neighbors

Static hygiene hooks lint the tree on every command; pi-closeout is
**lifecycle-scoped** — it fires when a session *ends* (or on demand), grades
findings by how they hurt the *next* session, and persists a per-session
closeout row. Pair it with pi-checkout-guard (which guards concurrent
mutations) for full shared-checkout hygiene: guard = during, closeout = after.

## Scope and non-goals

- **Not a linter.** It does not judge what is staged or untracked — only that
  something is, and how that hurts the next session.
- **Not a fixer.** It never stashes, commits, or deletes on your behalf.
- **Never blocks.** Findings are reported (and recorded); shutdown is not
  interrupted. Use `--strict` where a pipeline wants a non-zero exit.
- **Convention-aware, not convention-enforcing.** Claims and `Work-Session:`
  trailers are *your* conventions: nothing is flagged until the file or the
  trailer exists in the repo.

## Requirements

| Requirement | Needed for | If missing |
|---|---|---|
| pi ≥ 1.3 | the extension and `/closeout` | the shell script still works |
| Node ≥ 20 | the extension | same |
| git | everything | the gate reports nothing to check |
| a task file | claim findings | claims are simply not checked |

No network access, no telemetry, no runtime dependencies beyond pi's own
packages.

## Troubleshooting

**It reports the registry as an untracked file.** It should not: the fallback
registry lives inside `.git/`. If you configured `"registry"` with a path inside
the worktree, add that path to `ignoreUntracked`.

**Trailer findings for commits I made before adopting the convention.** Set
`checkWorkSessionTrailer: "false"` to disable, or rely on `"auto"`, which only
looks at commits newer than the newest trailer-bearing one — and stays silent
entirely in repos that never adopted the trailer.

**Claim findings for a task file I don't use.** Point `claimsFiles` at your own
board (any file), or clear the array to disable the check.

**`/closeout` reports a dirty child repo I don't own.** Nested repos are checked
to depth 2; set `childRepos: false` when a vendored repo is out of scope.

## Related packages

Five extensions for the same problem — agent sessions sharing a checkout —
covering different moments:

| Package | Moment | Guards against |
|---|---|---|
| [pi-rc-gate](https://github.com/jyyyeung/pi-rc-gate) | at execution | the failure signal being destroyed, so a red command is reported green |
| [pi-checkout-guard](https://github.com/jyyyeung/pi-checkout-guard) | during | concurrent sessions wiping each other's uncommitted work |
| **pi-closeout** (this) | at session end | the dirty state a session leaves for the next one |
| [pi-retro](https://github.com/jyyyeung/pi-retro) | weekly | friction that keeps recurring because nobody wrote it down |
| [pi-handoff](https://github.com/jyyyeung/pi-handoff) | between sessions | context lost when a session ends |

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © jyyyeung
