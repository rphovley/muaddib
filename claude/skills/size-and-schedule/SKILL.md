---
name: size-and-schedule
description: Fleet planning step. Reads a ticket's Sizing Signal and, only when the project's sizing hook recommends a split, drafts dependent sub-issues from the plan's work streams, creates them, wires native blocking relations between them, gives each a scoped `## Context` comment, and posts a `## Sizing & Scheduling` plan on the parent for review. A no-op when the hook says don't split. Never implements the confirmation loop; never calls AskUserQuestion.
---

# Size and Schedule

Fleet planning step. Consumes the Sizing Signal (`orchestrator/sizing-signal-cli.js`)
and, **only when the project's sizing hook recommends a split**, decomposes the
ticket into dependent sub-issues wired with native task-manager blocking
relations, then posts a sizing/scheduling plan on the parent for human review.

This step **stops at posting the review comment.** The human confirmation loop
(review → confirm → spawn the children) is a separate sub-issue and out of scope
here. It never implements, never commits, and never calls `AskUserQuestion`.

`$ARGUMENTS` is the ticket identifier (e.g. `QUO-325` for Linear, `muaddib#106`
for GitHub). `STATE_TICKET_URL` is the full ticket URL (empty for a raw /
free-form task). `STEP_DONE_FILE` is the completion sentinel.

**Autonomous execution**: run all steps in a single continuous pass. Do not
pause or narrate between steps. Resolve the muaddib root once and reuse it:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
SIZING_CLI="$MUADDIB_ROOT/orchestrator/sizing-signal-cli.js"
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
```

## Step 1 — Sizing signal

Obtain the Sizing Signal for the ticket:

```bash
node "$SIZING_CLI" "$ARGUMENTS"   # prints resolved result as pretty JSON
```

Parse the JSON. It is one of:
- `{ "configured": false }` — no sizing hook configured (muaddib's own
  self-hosting steady state).
- `{ "configured": true, "signal": { "size", "confidence", "recommendSplit", "blockingQuestions"? } }`

**Finish as a clean no-op (Step 1 only)** if any of these hold — write
`recommend_split=false` to state, touch the sentinel, and stop. No comment, no
children:

- The CLI exits non-zero (a misbehaving configured hook), **or**
- `configured === false`, **or**
- `signal.recommendSplit === false`.

```bash
node "$STATE_CLI" "$WORKER" set recommend_split "false"
touch "$STEP_DONE_FILE"
```

This no-op path is the common case and must stay silent. Only continue to Step 2
when `configured === true` **and** `signal.recommendSplit === true`.

Also skip everything below (comments, sub-issues) and finish the same no-op way
if `$STATE_TICKET_URL` is empty — a raw / free-form task has no backend to write
to. (The ticket CLI already no-ops raw writes, but skipping early avoids need­less
work.) Write `recommend_split=false`, touch the sentinel, stop.

## Step 2 — Draft children from the plan

Read `.muaddib/plan.md` (the `analyze-ticket` / `wash-hands` plan already written
this run) and locate its `### Work Streams`. If `.muaddib/plan.md` is missing or
has no work streams, there is nothing to decompose — write `recommend_split=false`,
touch the sentinel, and stop.

Turn **each dependency-ordered work stream into one child issue**:

- `title = "<parent title> — <stream name>"` (parent title from `STATE_TICKET_TITLE`).
- `description` = that stream's concrete steps, plus the slice of the plan's
  `## Acceptance` / acceptance criteria that applies to this stream.

Draft in dependency order and capture the intended blocker→blocked edges. The
default is a **linear chain**: Stream N blocks Stream N+1 (Stream 1 is the
blocker of Stream 2, Stream 2 blocks Stream 3, …). If the plan explicitly marks a
stream as depending on a specific other stream ("depends on Stream 1"), use that
edge instead of the linear default.

Write each child's description to a temp file for the create step:

```bash
# for stream <n>, write its markdown body to:
#   /tmp/sched-child-${WORKER}-<n>.md
```

## Step 3 — Create sub-issues

For each drafted child, in dependency order, pipe its description on stdin:

```bash
node "$TICKET_CLI" create-sub-issue "$ARGUMENTS" "<parent title> — <stream name>" \
    < "/tmp/sched-child-${WORKER}-<n>.md"   # prints the child ticket JSON
```

Parse each printed child JSON for its `identifier`. Keep an **ordered list** of
the new identifiers, aligned with the stream order — this is what Step 4's edges
and Step 6's plan reference.

## Step 4 — Wire native blocking relations

For each intended edge captured in Step 2, using the real child identifiers from
Step 3, create the native `blocks` relation (blocker first, blocked second):

```bash
node "$TICKET_CLI" add-blocking-relation "<blockerId>" "<blockedId>"
```

For the default linear chain over children `[c1, c2, c3, …]`, that is
`add-blocking-relation c1 c2`, `add-blocking-relation c2 c3`, … These are native
task-manager relations, not a muaddib-side graph.

## Step 5 — Scoped `## Context` per child

If `.muaddib/context.md` is **absent** (no `contextSources` configured — muaddib's
own steady state), skip this step cleanly.

If it exists, read it — it is the parent's aggregated context (written by
`gather-context`; own→parent precedence already resolved there). For each child,
select the slice relevant to that work stream and post it as the child's own
`## Context` comment. The body **must start with a `## Context` header** so it
matches `extractContextSection`'s anchor and the read-back helpers in
`services/context-comments.js` find it:

```bash
# write the scoped markdown (beginning with "## Context") to:
#   /tmp/sched-context-${WORKER}-<n>.md
node "$TICKET_CLI" post-comment "<childId>" < "/tmp/sched-context-${WORKER}-<n>.md"
```

If a child has no relevant slice, omit its context comment rather than posting an
empty `## Context`.

## Step 6 — Post the sizing/scheduling plan for review

Assemble a `## Sizing & Scheduling` comment and post it on the **parent**:

```markdown
## Sizing & Scheduling

**Size:** <size> (confidence: <confidence>)

**Sub-issues** (dependency order):
1. <childId> — <parent title> — <stream 1 name>
2. <childId> — <parent title> — <stream 2 name>
...

**Blocking relations:**
- <blockerId> blocks <blockedId>
- ...

_Review these before spawning. Confirmation is a separate step._
```

Post it (body on stdin — large multi-line markdown):

```bash
# write the assembled comment to /tmp/sched-plan-${WORKER}.md, then:
node "$TICKET_CLI" post-comment "$ARGUMENTS" < "/tmp/sched-plan-${WORKER}.md"
```

Record the outcome in state:

```bash
node "$STATE_CLI" "$WORKER" set recommend_split "true"
node "$STATE_CLI" "$WORKER" set sub_issues '<json array of child identifiers>'   # e.g. ["CHILD-1","CHILD-2"]
```

Do **not** implement the confirmation loop — that is a separate sub-issue.

## Step 7 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
