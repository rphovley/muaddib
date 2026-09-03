---
name: confirm-sizing
description: Fleet sizing-review step. Shows the operator the "## Sizing & Scheduling" preview posted by size-and-schedule --propose and asks (via AskUserQuestion) whether to create tickets and dispatch, create tickets only, or adjust the plan. Writes the choice to worker state for the sizing-review loop. Runs one round.
---

# Confirm Sizing

Called in a loop by `plan.json`'s `sizing-review-loop` step (see
`muaddib/workflows/plan.json` — a declarative `loop` step, the same primitive
`sketch-review-loop` and `quality-loop` use). Runs exactly one round — show the
preview, ask, record the choice, done. The loop, not this skill, owns the
"wait, then decide what happens next" looping.

`$ARGUMENTS` is the ticket identifier (source-neutral — Linear, GitHub, or raw).

The `size-and-schedule --propose` step that ran before this loop posted a
`## Sizing & Scheduling` PREVIEW comment on the ticket — the planned sub-issues
(by work stream) and their planned blocking relations, with **nothing created
yet**. This step asks the operator to confirm that plan before any tickets exist,
so option 3 (adjust) can revise it without orphaning already-created issues.

## Step 0 — Print the review banner before asking

This step's window is the one the operator lands on. Echo the ticket URL and the
preview location as a banner so it's always visible no matter when the operator
attaches. This reprints every round since the orchestrator loops this skill.

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER_INDEX="${WORKER_INDEX:-$(cat /tmp/worker-index 2>/dev/null)}"
: "${WORKER_INDEX:?WORKER_INDEX not set (env and /tmp/worker-index both empty)}"
WORKER="$WORKER_INDEX"
TICKET_URL="$(node "$STATE_CLI" "$WORKER" get ticket_url)"
echo "──────────────────────────────────────────────────────────"
echo " Sizing & Scheduling ready for review:"
echo "   ${TICKET_URL:-<ticket_url not recorded>}"
echo " See the latest '## Sizing & Scheduling' comment on the ticket."
echo "──────────────────────────────────────────────────────────"
```

## Step 1 — Clear the previous round's choice

Clear any stale `sizing_confirm` first — if this round's session exits before
Step 3 (crash, interrupted), a stale value left from last time would either
exit the loop prematurely or re-run `adjust-sizing`. Clearing it means an
incomplete round just asks again on the next loop iteration (`minIterations: 1`
guarantees at least one real ask).

```bash
node "$STATE_CLI" "$WORKER" unset sizing_confirm
rm -f "/tmp/sizing-adjust-${WORKER}.txt"
```

Read the ticket's latest `## Sizing & Scheduling` comment (and `.muaddib/plan.md`)
so you can summarize the proposed streams and edges to the operator in the
question preamble.

## Step 2 — Ask the operator

Call `AskUserQuestion` with a single question — "The ticket was sized and this
split is proposed. How should I proceed?" — and exactly these three options:

1. **Create tickets and dispatch** — create the sub-issues, wire the blocking
   relations, and mark them ready for the dispatch daemon to pick up.
2. **Create tickets only** — create the sub-issues and wire the relations, but do
   not dispatch (a human will dispatch them later).
3. **Needs adjustment** — the split is wrong; describe what to change.

Do not expand the option list. Keep the preamble to a short summary of the
proposed streams so the operator can decide.

## Step 3 — Record the choice

Map the answer to `sizing_confirm` in worker state — the loop's `exitCondition`
and `size-and-schedule --commit` both read it:

- Option 1 → `node "$STATE_CLI" "$WORKER" set sizing_confirm dispatch`
- Option 2 → `node "$STATE_CLI" "$WORKER" set sizing_confirm tickets_only`
- Option 3 → `node "$STATE_CLI" "$WORKER" set sizing_confirm adjust`, and write
  the operator's requested changes (verbatim or lightly trimmed) to
  `/tmp/sizing-adjust-${WORKER}.txt` for the `adjust-sizing` step:

```bash
cat > "/tmp/sizing-adjust-${WORKER}.txt" <<'EOF'
<the operator's requested changes>
EOF
```

Options 1 and 2 exit the loop (→ `size-and-schedule --commit`). Option 3 runs
`adjust-sizing`, which revises the plan and re-posts a fresh preview, then loops
back here.

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
