#!/usr/bin/env bash
# career-finder statusline: shows batch progress + cwd + model.
# Reads JSON on stdin from Claude Code, writes one-line status to stdout.
set -uo pipefail

input=$(cat 2>/dev/null || echo '{}')

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)
model=$(echo "$input" | jq -r '.model.display_name // "claude"' 2>/dev/null)
dir_name="${cwd##*/}"

# Derive from this script's own location so the repo is portable (it is a
# statusline hook, so $cwd is the user's shell dir, not necessarily the repo).
BATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATE="$BATCH_DIR/batch-state.tsv"
INPUT="$BATCH_DIR/batch-input.tsv"
QUOTA="$BATCH_DIR/QUOTA_HIT"

batch_segment=""
# Show bar if state file exists and was touched in last 2 hours (active run)
if [[ -f "$STATE" ]] && [[ -n "$(find "$STATE" -mmin -120 2>/dev/null)" ]]; then
  total=$(tail -n +2 "$INPUT" 2>/dev/null | grep -c '[^[:space:]]')
  total=${total:-0}
  completed=$(awk -F'\t' 'NR>1 && $3=="completed"' "$STATE" 2>/dev/null | wc -l | tr -d ' ')
  failed=$(awk -F'\t' 'NR>1 && $3=="failed"' "$STATE" 2>/dev/null | wc -l | tr -d ' ')
  skipped=$(awk -F'\t' 'NR>1 && $3=="skipped"' "$STATE" 2>/dev/null | wc -l | tr -d ' ')
  processing=$(awk -F'\t' 'NR>1 && $3=="processing"' "$STATE" 2>/dev/null | wc -l | tr -d ' ')
  # Terminal = jobs that won't be retried (completed + skipped)
  terminal=$((completed + skipped))
  remaining=$((total - terminal))

  if (( total > 0 )); then
    bar_width=15
    filled=$((terminal * bar_width / total))
    (( filled > bar_width )) && filled=$bar_width
    bar=""
    for ((i=0; i<filled; i++)); do bar+="█"; done
    for ((i=filled; i<bar_width; i++)); do bar+="░"; done

    quota_flag=""
    [[ -f "$QUOTA" ]] && quota_flag=" 🛑QUOTA"

    # Bar fills by terminal states; breakdown shows everything
    batch_segment=" | batch [$bar] ${terminal}/${total} (${remaining} left) ✅${completed} ⏭${skipped} ❌${failed} ⏳${processing}${quota_flag}"
  fi
fi

printf '%s | %s%s\n' "$model" "$dir_name" "$batch_segment"
