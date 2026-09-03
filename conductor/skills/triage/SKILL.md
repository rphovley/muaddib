---
name: triage
description: Decide whether a blocked or awaiting-review worker's question can be answered directly by the Conductor or must be escalated to a human, weighing the project's configured autonomy level. Produces a decision (answer-directly vs. escalate), a drafted answer when answering directly, and a rationale.
---

# Triage

A worker has stopped and is waiting on an answer — it is blocked mid-task, or it
is holding a change for review. Your job is to decide **who answers**: you (the
Conductor, on the human's behalf) or the human operator. This is a triage
decision, not the answer's implementation.

## Inputs

- **The question and its context.** What the worker asked, why it stopped, and
  the surrounding state it gathered before stopping (the ticket, the plan, the
  diff, prior comments). Read enough of this to judge the question — do not
  answer from the one-line summary alone.
- **The project's configured autonomy level.** How much latitude this project
  has granted the Conductor to act without a human in the loop. Treat it as the
  threshold between "answer directly" and "escalate": a low autonomy level means
  escalate unless the answer is unambiguous and low-stakes; a high autonomy level
  means answer directly unless the decision is genuinely irreversible or outside
  the granted scope.

  > This value is supplied by the project's autonomy configuration. Reference it
  > as a conceptual input — do not hard-code where it lives or what it is named;
  > read whichever value the caller provides. (The concrete `autonomyLevel`
  > input lands separately; until then, treat an unspecified level as low and
  > lean toward escalating.)

## What to decide

Choose exactly one:

- **Answer directly** — the question is within the granted autonomy, the answer
  is well-supported by the code, the ticket, or a recorded prior decision, and
  getting it wrong is cheap to reverse. Draft the actual answer the worker needs
  to unblock, grounded in what you read. Do not escalate a question you can
  answer just to be safe — that defeats the Conductor's purpose.
- **Escalate to the human** — the decision exceeds the granted autonomy, the
  question is genuinely ambiguous with no supported answer, the choice is
  hard to reverse (data loss, external side effects, product direction, cost),
  or it contradicts a stated goal or constraint. Summarize the question crisply
  and, where you can, lay out the options and your recommendation so the human
  decides fast.

## Output

Produce, in this order:

1. **Decision:** `answer-directly` or `escalate`.
2. **Rationale:** one short paragraph — the specific facts (autonomy level,
   reversibility, how well-supported the answer is) that drove the decision.
3. **Payload:**
   - For `answer-directly`: the drafted answer to hand back to the worker,
     phrased as the unblocking instruction it needs.
   - For `escalate`: the question restated for the human, the options you see,
     and your recommendation.

Decide only. Delivering the answer to the worker, or notifying the human, is the
caller's step — not this skill's.
