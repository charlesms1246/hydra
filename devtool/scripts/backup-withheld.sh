#!/usr/bin/env bash
#
# backup-withheld.sh — copy the withheld trees somewhere git cannot lose them.
#
# STOPGAP. This exists because three directories are gitignored pending coordinated
# disclosure (HANDOFF.md §5), so git holds no history for them and a stray `rm -rf`
# or a bad edit is unrecoverable. It has an end date: the disclosure commit un-ignores
# `findings/`, and the same act should retire this script. The real fix is that these
# stop being islands — not that they are backed up more diligently.
#
#   findings/                    never tracked; all seven were rewritten from scratch
#                                on 2026-09-04 after being lost exactly this way.
#   upstream-prs/                untracked deliberately; the StarkWare patches.
#   devtool/packages/mcp/        withheld in a67514b — they document, with source
#   devtool/packages/skills/     citations, disclosures held until StarkWare is
#                                contacted privately.
#
# Why a script and not a habit: on 2026-09-04 a backup was taken, the files were then
# edited, and the backup silently became a record of the state before the fix. That
# happened twice in one day. Re-sync after ANY edit to an ignored tree, or the copy
# documents the mistake instead of the correction.
#
# Why not a git hook: a hook changes how everyone's commits behave and is the
# repository owner's decision, not this script's.
#
# Usage:   devtool/scripts/backup-withheld.sh [destination]
# Default: ~/hydra-backups/<UTC timestamp>
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$HOME/hydra-backups/$(date -u +%Y%m%d-%H%M%S)}"

# PRE-EDIT copies are frozen rollback points. A re-sync must never overwrite one:
# that split exists precisely so the state before an edit survives the edit.
PROTECTED_SUFFIX=".PRE-EDIT"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  FAILED: %s\n\n' "$*" >&2; exit 1; }

[ -d "$REPO/.git" ] || die "not a hydra checkout: $REPO"

mkdir -p "$DEST"
printf '\n  backing up withheld trees\n    from  %s\n    to    %s\n\n' "$REPO" "$DEST"

# source path (relative to repo)      destination name
SETS=(
  "findings|findings"
  "upstream-prs|upstream-prs.CURRENT"
  "devtool/packages/mcp|devtool-ignored-packages/mcp"
  "devtool/packages/skills|devtool-ignored-packages/skills"
)

copied=0
skipped=0

for entry in "${SETS[@]}"; do
  src="$REPO/${entry%%|*}"
  dst="$DEST/${entry##*|}"

  if [ ! -d "$src" ]; then
    say "skip     ${entry%%|*} — not present"
    skipped=$((skipped + 1))
    continue
  fi

  case "$dst" in
    *"$PROTECTED_SUFFIX"*) die "refusing to write a $PROTECTED_SUFFIX path: $dst" ;;
  esac

  mkdir -p "$(dirname "$dst")"
  # --delete so a file removed upstream is removed here too; a backup that keeps
  # deleted files is a different tree, not a copy of this one.
  rsync -a --delete --exclude node_modules "$src/" "$dst/"

  # Verify rather than trust. A script that silently half-copies is worse than
  # doing it by hand, because doing it by hand made somebody look at the output.
  if diff -r --exclude node_modules "$src" "$dst" >/dev/null; then
    say "ok       ${entry%%|*}  ($(find "$dst" -type f | wc -l | tr -d ' ') files)"
    copied=$((copied + 1))
  else
    diff -r --exclude node_modules "$src" "$dst" | head -20 >&2
    die "verification failed for ${entry%%|*} — copy does not match source"
  fi
done

# Report, never touch, any frozen rollback points already in the destination.
while IFS= read -r frozen; do
  say "frozen   $(basename "$frozen") — left untouched"
done < <(find "$DEST" -maxdepth 1 -name "*$PROTECTED_SUFFIX" 2>/dev/null)

printf '\n  %d verified, %d skipped\n\n' "$copied" "$skipped"
