#!/usr/bin/env bash
# Wrapper that runs batch-runner.sh and detects quota exhaustion.
# Writes resume marker file with reset time so the parent (Claude session)
# can schedule a re-launch.
set -uo pipefail

cd "$(dirname "$0")"

PARALLEL="${1:-3}"
MIN_SCORE="${2:-3.5}"
MARKER=batch/auto-resume.marker
ATTEMPT=0

rm -f "$MARKER"

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if [[ "$ATTEMPT" -eq 1 ]]; then
    RETRY_FLAG=""
  else
    RETRY_FLAG="--retry-failed"
  fi
  echo "=== auto-resume: attempt #$ATTEMPT batch (parallel=$PARALLEL min-score=$MIN_SCORE $RETRY_FLAG) at $(date) ==="
  ./batch/batch-runner.sh --parallel "$PARALLEL" --min-score "$MIN_SCORE" $RETRY_FLAG 2>&1 | tee -a batch/auto-resume.log

  # If no failures with quota errors, we're done
  quota_hit=$(grep -h "hit your limit" batch/logs/*.log 2>/dev/null | tail -1)
  if [[ -z "$quota_hit" ]]; then
    echo "=== auto-resume: batch complete with no quota issues at $(date) ==="
    echo "DONE" > "$MARKER"
    break
  fi

  # Check if any pending/failed jobs remain
  failed_count=$(awk -F'\t' 'NR>1 && $3=="failed"' batch/batch-state.tsv | wc -l | tr -d ' ')
  if [[ "$failed_count" -eq 0 ]]; then
    echo "=== auto-resume: no failed jobs left at $(date) ==="
    echo "DONE" > "$MARKER"
    break
  fi

  # Parse reset time from quota message: "resets 7pm (<IANA zone>)"
  reset_clock=$(echo "$quota_hit" | grep -oE "resets [0-9]+(am|pm)" | tail -1 | awk '{print $2}')
  echo "=== auto-resume: hit quota, reset clock = $reset_clock ==="
  echo "WAITING reset=$reset_clock failed=$failed_count" > "$MARKER"

  # Convert reset_clock (e.g. "4am") to a future epoch timestamp
  hour_part=$(echo "$reset_clock" | grep -oE "^[0-9]+")
  am_pm=$(echo "$reset_clock" | grep -oE "(am|pm)$")
  if [[ "$am_pm" == "pm" && "$hour_part" -ne 12 ]]; then
    hour_24=$((hour_part + 12))
  elif [[ "$am_pm" == "am" && "$hour_part" -eq 12 ]]; then
    hour_24=0
  else
    hour_24=$hour_part
  fi

  now_epoch=$(date +%s)
  today_reset=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) ${hour_24}:05:00" +%s 2>/dev/null || echo 0)
  if [[ "$today_reset" -le "$now_epoch" || "$today_reset" -eq 0 ]]; then
    today_reset=$((now_epoch + 3600))
  fi
  wait_secs=$((today_reset - now_epoch))
  # Cap wait to 6 hours as a safety
  if [[ "$wait_secs" -gt 21600 ]]; then wait_secs=21600; fi
  echo "=== auto-resume: sleeping ${wait_secs}s until $(date -r $today_reset) ==="

  sleep "$wait_secs"
  echo "=== auto-resume: woke up at $(date), retrying failed jobs ==="
done

echo "=== auto-resume: all done at $(date) ==="
