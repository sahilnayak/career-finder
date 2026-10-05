#!/bin/sh
# detect-outcomes.sh — auto-detect application outcomes from Gmail (READ-ONLY) and
# feed the learning loop, so feedback-outcomes.mjs has DECIDED outcomes to learn from
# without the user hand-logging every reply.
#
# For each in-flight applied job (scripts/applied-watchlist.mjs), a headless claude -p
# searches Gmail for the company's response, classifies it, and runs record-outcome.mjs;
# then feedback-outcomes.mjs --learn banks a data-driven learning once >=5 are decided.
# It NEVER sends, replies to, deletes, archives, labels, or modifies any email.
#
# Runnable standalone; needs the claude CLI with the Gmail MCP configured.

# NOTE: scripts/morning.mjs runs the same detection once a day; this is the standalone entry point.
cd "$(dirname "$0")/.." || exit 1
PLOG=${1:-data/_pipeline.log}

N=$(node scripts/applied-watchlist.mjs 2>/dev/null | node -e "try{let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))}catch(e){console.log(0)}")
if [ "${N:-0}" -lt 1 ] || ! command -v claude >/dev/null 2>&1; then
  echo "outcome-detect: no in-flight applied jobs (or claude missing); skipped" >> "$PLOG"
  exit 0
fi

claude -p "Application outcome detection — READ-ONLY Gmail. Detect what happened with the jobs the user applied to and log it, so the feedback loop has decided outcomes.

STEP 1: run 'node scripts/applied-watchlist.mjs' to get the JSON list of in-flight applied jobs (fields: company, role, date applied, optional domain).

STEP 2: for EACH job, search Gmail with the gmail MCP (search_emails then read_email). READ-ONLY: never send, reply, draft, delete, archive, label, mark-read, or modify ANYTHING. Search for messages received on/after the applied date that relate to this company and role: prefer from:<domain> when a domain is given, else the company name in from/subject. Read the most relevant message thread.

STEP 3: classify the LATEST signal for that job into exactly one bucket:
  - rejected   = explicit rejection ('unfortunately', 'not moving forward', 'pursue other candidates', 'won't be proceeding', 'not a fit at this time').
  - interview  = an interview / phone-screen invite OR a scheduling link (Calendly, GoodTime, 'find a time', 'schedule a call', 'availability').
  - offer      = a job offer ('pleased to offer', 'offer letter', 'extend an offer').
  - responded  = a real human reply from a recruiter/HM that advances the process (asks a question, wants to talk) — NOT an automated receipt.
  - NONE       = only an automated 'we received your application / thanks for applying' acknowledgement, or no relevant email found. Do NOT change the outcome.
Be conservative: an auto-acknowledgement is NOT 'responded'. Only log a decided outcome when the email clearly supports it.

STEP 4: for each job with a decided signal, run 'node scripts/record-outcome.mjs \"<company>\" <responded|interview|offer|rejected>' (exact company name; matches by company/url substring). NEVER regress a status (do not turn an interview/offer back into applied). ALSO update the Status cell for that company's row in data/applications.md to match the detected outcome (Applied -> Interview, etc.) and append a short dated note like '(auto-detected from Gmail YYYY-MM-DD)'; you may edit existing applications.md rows but never add new ones.

STEP 5: run 'node scripts/feedback-outcomes.mjs --learn'.

End with ONE line: 'outcomes: applied A, rejected R, interview I, offer O, responded P'. Reminder: search and read only — modify NOTHING in Gmail." --model sonnet --dangerously-skip-permissions >> "$PLOG" 2>&1
