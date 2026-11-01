#!/usr/bin/env bash
# session-closeout.sh — harness-agnostic closeout gate (humans, Claude Code,
# Codex, cron, CI). Companion to the pi-closeout extension; same checks.
#
# Checks the work session is not leaving loose ends on a (possibly shared)
# checkout:
#   1. staged-but-uncommitted items  (sweep fuel for concurrent commits)
#   2. untracked files               (stash-cycle bait)
#   3. modified files at this root   (informational)
#   4. child repos with dirty trees  (informational)
#   5. open claims in CLAIMS_FILE    (default TASKS.md, pattern CLAIMS_PATTERN)
#   6. recent commits missing the Work-Session trailer (auto-detected; silent
#      when the convention is not in use — set CHECK_WORK_SESSION_TRAILER to
#      true/false to force/skip)
#
# Exit codes: 0 = clean or advisory findings; 1 = findings with --strict;
#             2 = usage/context error.
#
# Env overrides: WORK_SESSION (identity string), CLAIMS_FILE, CLAIMS_PATTERN,
#                CLOSEOUT_REGISTRY (file to append a closeout row to),
#                CHECK_WORK_SESSION_TRAILER (auto/true/false).
set -euo pipefail
strict=0
for arg in "$@"; do
  case "$arg" in
    --strict) strict=1 ;;
    *) echo "usage: session-closeout.sh [--strict]" >&2; exit 2 ;;
  esac
done
command -v git >/dev/null || { echo "session-closeout: git not found" >&2; exit 2; }
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || { echo "session-closeout: not a git repo" >&2; exit 2; }
cd "$root"

claims_file="${CLAIMS_FILE:-TASKS.md}"
claims_pattern="${CLAIMS_PATTERN:-— claimed @}"
identity="${WORK_SESSION:-}"

findings=0
note() { printf '  %s\n' "$*"; }
flag() { findings=$((findings+1)); printf '  ✗ %s\n' "$*"; }

echo "session closeout — $root"
[ -n "$identity" ] && echo "  identity: Work-Session: $identity"

staged="$(git diff --cached --name-only || true)"
if [ -n "$staged" ]; then
  flag "staged-but-uncommitted (concurrent-session sweep fuel):"
  note "$(printf '%s\n' "$staged" | sed 's/^/    /')"
else
  note "✓ nothing staged"
fi

untracked="$(git ls-files --others --exclude-standard 2>/dev/null \
  | grep -vE '^(\.session-registry\.jsonl|\.pi-closeout\.jsonl|\.pi-closeout\.json)$' || true)"
if [ -n "$untracked" ]; then
  flag "untracked files (stash-cycle bait — commit, move, or own them):"
  note "$(printf '%s\n' "$untracked" | sed 's/^/    /')"
else
  note "✓ no untracked files"
fi

dirty_root="$(git status --short --untracked-files=no || true)"
if [ -n "$dirty_root" ]; then
  echo "  • modified at this root (finish, claim, or hand off):"
  note "$(printf '%s\n' "$dirty_root" | sed 's/^/    /')"
else
  note "✓ clean root tree"
fi

child_flagged=0
while IFS= read -r child; do
  child_dirty="$(git -C "$child" status --short --untracked-files=no 2>/dev/null || true)"
  if [ -n "$child_dirty" ]; then
    flag "child repo '$child' has uncommitted changes ($(printf '%s\n' "$child_dirty" | wc -l | tr -d ' ') files)"
    child_flagged=1
  fi
done < <(find . -maxdepth 2 -mindepth 2 -name .git 2>/dev/null | sed 's|/\.git$||; s|^\./||' | sort)
[ "$child_flagged" -eq 1 ] || note "✓ child repos clean (or none present)"

if [ -f "$claims_file" ]; then
  claims="$(grep -nF "$claims_pattern" "$claims_file" 2>/dev/null || true)"
  if [ -n "$claims" ]; then
    flag "open claims in $claims_file (resolve or re-claim):"
    note "$(printf '%s\n' "$claims" | sed 's/^/    /')"
  else
    note "✓ no open claims"
  fi
else
  note "✓ no $claims_file"
fi

# Work-Session trailer check — same auto-detect as the extension: when none of
# the last 30 commits on HEAD carries a Work-Session trailer, the convention
# is treated as not in use and this check says nothing. Merge commits are
# excluded (--no-merges): server-generated merge commits never carry trailers.
ws_mode="auto"
case "${CHECK_WORK_SESSION_TRAILER:-}" in
  true|TRUE) ws_mode=true ;;
  false|FALSE) ws_mode=false ;;
esac
if [ "$ws_mode" != false ] && git symbolic-ref -q HEAD >/dev/null 2>&1; then
  ws_missing=()
  ws_total=0
  ws_with=0
  while IFS= read -r -d $'\x1e' rec; do
    rec="${rec#$'\n'}"
    sha="${rec%%$'\x1f'*}"
    rest="${rec#*$'\x1f'}"
    subject="${rest%%$'\x1f'*}"
    trailers="${rest#*$'\x1f'}"
    [ -n "$sha" ] || continue
    ws_total=$((ws_total+1))
    if printf '%s\n' "$trailers" | grep -qiE '^[[:space:]]*Work-Session:[[:space:]]*[^[:space:]]'; then
      ws_with=$((ws_with+1))
    else
      ws_missing+=("$sha $subject")
    fi
  done < <(git log -n 30 --no-merges --pretty=format:'%h%x1f%s%x1f%(trailers)%x1e' 2>/dev/null || true)
  if [ "$ws_mode" = auto ] && [ "$ws_with" -eq 0 ]; then
    : # convention absent — stay silent
  elif [ "${#ws_missing[@]}" -gt 0 ]; then
    flag "recent commits missing the Work-Session trailer (provenance queries will miss them):"
    i=0
    for m in "${ws_missing[@]}"; do
      i=$((i+1))
      [ "$i" -gt 10 ] && break
      note "  $m — no Work-Session trailer"
    done
    extra=$(( ${#ws_missing[@]} - 10 ))
    [ "$extra" -gt 0 ] && note "  …and $extra older commits without trailers"
  elif [ "$ws_total" -gt 0 ]; then
    note "✓ recent commits carry Work-Session trailers"
  fi
fi

if [ -n "$identity" ] && [ -n "${CLOSEOUT_REGISTRY:-}" ] && [ -f "$CLOSEOUT_REGISTRY" ]; then
  printf '{"ts":%s000,"type":"closeout","session":"%s","findings":%d}\n' \
    "$(date +%s)" "$identity" "$findings" >> "$CLOSEOUT_REGISTRY"
  note "closeout row appended to $CLOSEOUT_REGISTRY"
fi

if [ "$findings" -gt 0 ]; then
  echo "session-closeout: $findings finding(s)"
  [ "$strict" -eq 1 ] && exit 1 || exit 0
fi
echo "session-closeout: clean"
exit 0
