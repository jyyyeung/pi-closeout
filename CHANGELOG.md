# Changelog

## 0.1.2

Fixed:

- **The gate no longer reports its own registry.** The fallback row file moved
  from `<root>/.pi-closeout.jsonl` (an untracked file inside the worktree, which
  the untracked check then flagged on an otherwise clean repo) to
  `<gitdir>/pi-closeout/registry.jsonl`. `.pi-closeout.jsonl` is also in the
  default `ignoreUntracked` list for the non-git/linked-worktree case.
- **Work-Session trailer check is scoped to the convention's start.** In `auto`
  mode only commits *newer* than the newest trailer-bearing commit count as
  gaps, so adopting the convention no longer retro-flags `init` and every older
  commit on the branch. `true` still checks the whole window.
- **Repo resolution is lazy** (from the session cwd on each hook) instead of
  once at extension load, so a session that starts outside a repo and then
  works inside one still gets an identity row and a working gate.
- Closeout rows now record `ok: false` when findings exist (previously always
  `true`, which made the persisted history useless for "did this session close
  dirty?").
- `test/closeout.test.ts` repo-root assertion compares real paths, so the suite
  passes on macOS (`/var` → `/private/var`).
