---
name: closeout
description: Session closeout gate — run before ending a work session, before claiming a task done, or when /closeout reports findings. Flags staged-but-uncommitted sweep fuel, untracked stash-bait, dirty child repos, and open task claims on a shared checkout.
---

# closeout skill

## When this applies

You are about to end a session, hand off, or declare work "done" on a
checkout that other agent sessions (or humans) may touch next. Loose ends you
leave become THEIR incidents: staged-but-uncommitted files get swept into
whoever commits next; untracked files get eaten by the next stash cycle;
unclaimed task lines go stale.

## Protocol

1. **Run `/closeout` before declaring done** or ending a session.
2. **Every `✗` finding must be resolved or explicitly owned:**
   - `staged` — commit it, or unstage. Staged files are sweep fuel for the
     next session's `git commit`.
   - `untracked` — commit it, move it, or delete it. If it must stay, say so
     in your final report (stash-bait disclosure).
   - `child` — child repos with uncommitted changes: finish their commits or
     hand off explicitly.
   - `claim` — open claims in the task file: resolve, or re-claim with a
     fresh date.
3. **Notes (`•`) are informational** — modified files at the root are fine if
   they are deliberate WIP; mention them when handing off.
4. **Record identity**: commits you make during the session should carry a
   `Work-Session: <identity>` trailer — the identity string from `/closeout`
   output. Advisory, never blocking.
5. Non-pi teammates run `scripts/session-closeout.sh` for the same gate.

## Why "findings" and not "errors"

The gate is advisory by design: it never blocks a shutdown, it records a
`closeout` row in the registry (`findings: N`) so a pattern of sessions
leaving loose ends becomes greppable history. `--strict` flips it to failing
for CI/pre-commit use.
